/**
 * 命令行入口: 与 HTTP API 完全同一套业务逻辑(都走 service.ts)。
 * 无界面时可用, 也可被其它程序当子进程调用(--json 输出)。
 */
import { APP_NAME_CN, APP_VERSION } from "./version.ts";
import { appRoot, configPath, loadConfig, saveConfig } from "./core/config.ts";
import { formatResult, type ModuleResult } from "./core/result.ts";
import type { ModuleId } from "./core/types.ts";
import { wadSuffix } from "./packs/baselocale.ts";
import { scanLocales } from "./packs/locales.ts";
import { getIngameStatus } from "./packs/inventory.ts";
import { getLobbyStatus } from "./modules/lobbyVoice.ts";
import { getLobbyLangState } from "./modules/lobbyLang.ts";
import { buildEnvFromConfig, doctor, getLocales, inspectPaths, planSwitch, startApplyTask, startRestoreTask, startUpdateCheckTask, startUpdateRunTask, updateConfig } from "./service.ts";
import { taskManager } from "./tasks/manager.ts";
import { startApiServer } from "./server/api.ts";
import { setLogFile, setLogLevel, type LogLevel } from "./core/logger.ts";

const MODULE_ALIASES: Record<string, ModuleId> = {
  lobby: "lobby_voice",
  lobby_voice: "lobby_voice",
  voice: "ingame_voice",
  ingame_voice: "ingame_voice",
  lang: "ingame_lang",
  ingame_lang: "ingame_lang",
  lobby_lang: "lobby_lang"
};

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

/** 纯布尔开关(后面跟的值不会被当成参数值)。 */
const BOOLEAN_FLAGS = new Set(["json", "force", "help", "h", "stats", "verbose"]);

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let command = "";
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    if (raw.startsWith("--")) {
      const [key, ...rest] = raw.slice(2).split("=");
      if (rest.length) {
        flags.set(key!, rest.join("="));
        continue;
      }
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key!) && next !== undefined && !next.startsWith("--")) {
        flags.set(key!, next); // 支持 "--port 43110" 这种空格写法
        i += 1;
        continue;
      }
      flags.set(key!, true);
      continue;
    }
    if (!command) command = raw;
    else positionals.push(raw);
  }
  return { command, positionals, flags };
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagBool(args: ParsedArgs, name: string): boolean | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) return true;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function parseModules(value: string | undefined): ModuleId[] | undefined {
  if (!value) return undefined;
  const modules: ModuleId[] = [];
  for (const part of value.split(",")) {
    const key = part.trim().toLowerCase();
    const module = MODULE_ALIASES[key];
    if (!module) throw new Error(`未知模块: ${part}（可用: lobby_voice, ingame_voice, ingame_lang, lobby_lang）`);
    if (!modules.includes(module)) modules.push(module);
  }
  return modules.length ? modules : undefined;
}

function print(line = ""): void {
  console.log(line);
}

function printResults(results: ModuleResult[] | undefined): void {
  if (!results?.length) return;
  for (const item of results) {
    print(`  [${item.ok ? "√" : "×"}] ${formatResult(item)}`);
    if (!item.ok && item.message) print(`        ${item.message.replace(/\n/g, "\n        ")}`);
  }
}

/** 订阅任务进度, 把进度条打到终端。 */
function attachProgress(jsonMode: boolean): () => void {
  if (jsonMode) return () => undefined;
  let last = "";
  const unsubscribe = taskManager.subscribe((event) => {
    if (event.type === "progress") {
      const { done, total, percent, current } = event.progress;
      const line = total > 0
        ? `  ↳ ${percent.toFixed(1)}% (${done}/${total})${current ? " " + current : ""}`
        : `  ↳ ${current || "进行中…"}`;
      if (line !== last) {
        last = line;
        process.stdout.write(`\r${line.padEnd(110)}`);
      }
    } else if (event.type === "log") {
      process.stdout.write(`\r${"".padEnd(110)}\r`);
      print(`  · ${event.line}`);
      last = "";
    } else if (event.type === "done") {
      if (last) process.stdout.write(`\r${"".padEnd(110)}\r`);
      last = "";
    }
  });
  return unsubscribe;
}

async function runTask(jsonMode: boolean, starter: () => { id: string }): Promise<number> {
  const unsubscribe = attachProgress(jsonMode);
  let record;
  try {
    const task = starter();
    record = await taskManager.waitFor(task.id);
  } catch (error) {
    unsubscribe();
    print(`[-] ${String((error as Error).message ?? error)}`);
    return 1;
  }
  unsubscribe();
  if (!record) {
    print("[-] 任务丢失");
    return 1;
  }
  if (jsonMode) {
    print(JSON.stringify({ ok: record.status === "succeeded", status: record.status, result: record.result, error: record.error }, null, 2));
  } else {
    const result = record.result as { message?: string; results?: ModuleResult[] } | null;
    printResults(result?.results);
    if (record.status === "succeeded") print(`[+] ${result?.message ?? "完成"}`);
    else if (record.status === "cancelled") print("[-] 已取消");
    else print(`[-] 失败: ${record.error || result?.message || "未知错误"}`);
  }
  return record.status === "succeeded" ? 0 : 1;
}

async function commandStatus(jsonMode: boolean): Promise<number> {
  const config = await loadConfig();
  const env = await buildEnvFromConfig(config);
  const [ingame, lobby, lobbyLang] = await Promise.all([
    getIngameStatus({ finalDir: env.finalDir, voiceRoot: env.voiceRoot, locale: config.defaultLocale, message: env.resolution.message, source: env.resolution.source }),
    getLobbyStatus(env),
    getLobbyLangState(env)
  ]);
  const locales = await scanLocales(env.voiceRoot, { withCounts: false });

  if (jsonMode) {
    print(JSON.stringify({ ok: true, paths: env.resolution, voiceRoot: env.voiceRoot, ingame, lobby, lobbyLang, locales }, null, 2));
    return 0;
  }

  print("=".repeat(60));
  print(`    ${APP_NAME_CN} v${APP_VERSION}`);
  print("=".repeat(60));
  print(`  资源目录: ${env.voiceRoot}  (来源: ${env.voiceRootSource}, 可用语言包 ${locales.length} 个)`);
  print(`  客户端目录: ${env.resolution.leagueDir || "(未定位)"}`);
  if (env.resolution.finalDir) print(`  游戏文件目录: ${env.resolution.finalDir}`);
  else print(`  [!] ${env.resolution.message.split("\n")[0]}`);
  print(`  客户端渠道: ${env.region === "cn" ? "国服" : "外服"}（基准语种 ${env.baseLocale}，槽位 ${wadSuffix(env.baseLocale)}）`);
  print("-".repeat(60));
  print(`  【对局端】语音/播报: ${ingame.voice} | 语言: ${ingame.lang}`);
  print(`  【大厅端】选人语音: ${lobby.voice} | 语言: ${lobbyLang.label}`);
  print(`  选人语音资源包: ${lobby.wad_available ? lobby.wad_file : "未定位"}`);
  print("=".repeat(60));
  return 0;
}

async function commandLocales(jsonMode: boolean): Promise<number> {
  const payload = await getLocales({ withCounts: true });
  if (jsonMode) {
    print(JSON.stringify({ ok: true, ...payload }, null, 2));
    return 0;
  }
  print(`资源目录: ${payload.root}（当前生效: ${payload.active_locale}）`);
  if (!payload.locales.length) {
    print("[-] 未发现任何有效的语言包目录");
    return 1;
  }
  for (const item of payload.locales) {
    const flags = [
      item.has_voice ? `对局语音✓(${item.voice_files})` : "对局语音✗",
      item.has_lang ? `对局文本✓(${item.lang_files})` : "对局文本✗",
      item.has_lobby ? `大厅选人✓(${item.lobby_files})` : "大厅选人✗"
    ].join("  ");
    print(`  ${item.active ? "★" : " "} ${item.code.padEnd(6)} ${item.name.padEnd(18)} ${flags}`);
  }
  return 0;
}

async function commandPlan(args: ParsedArgs, jsonMode: boolean): Promise<number> {
  const config = await loadConfig();
  const locale = flagString(args, "locale") ?? args.positionals[0] ?? config.defaultLocale;
  const modules = parseModules(flagString(args, "modules"));
  const plan = await planSwitch({ locale, modules });
  if (jsonMode) {
    print(JSON.stringify({ ok: plan.ok, plan }, null, 2));
    return plan.ok ? 0 : 1;
  }
  print(`语言包: ${locale}  资源目录: ${plan.voiceRoot}`);
  for (const check of plan.checks) print(`  [${check.ok ? "√" : "×"}] ${check.module_name}: ${check.message}`);
  if (plan.space.needed) print(`  磁盘: ${plan.space.message || plan.space.detail}`);
  for (const warning of plan.warnings) print(`  [!] ${warning}`);
  if (plan.blockers.length) {
    print("[-] 无法开始：");
    for (const blocker of plan.blockers) print(`    ${blocker.replace(/\n/g, "\n    ")}`);
    return 1;
  }
  print("[+] 预检通过，可以开始切换");
  return 0;
}

/** 打开系统默认浏览器(打不开也不影响服务)。 */
async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  try {
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const child =
      process.platform === "win32"
        ? spawn(command, ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true })
        : spawn(command, [url], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    /* 忽略 */
  }
}

async function commandServe(args: ParsedArgs): Promise<number> {
  const config = await loadConfig();
  const host = flagString(args, "host") ?? config.server.host;
  const port = Number(flagString(args, "port") ?? config.server.port);
  let started;
  try {
    started = await startApiServer({ host, port });
  } catch (error) {
    const message = String((error as Error).message ?? error);
    if (/EADDRINUSE/i.test(message)) {
      print(`[-] 端口 ${port} 已被占用：可能已经有一个本工具在运行。`);
      print(`    请直接打开 http://${host}:${port}/ ，或换一个端口：node src/index.ts serve --port 43111 --open`);
    } else {
      print(`[-] 启动服务失败: ${message}`);
    }
    return 1;
  }
  const { running } = started;
  print(`[+] API 服务已启动: http://${running.host}:${running.port}`);
  print(`    状态: GET /api/state   语言包: GET /api/locales   事件: GET /api/events`);
  print("    按 Ctrl+C 退出");
  if (flagBool(args, "open")) {
    const url = `http://${running.host === "0.0.0.0" ? "127.0.0.1" : running.host}:${running.port}/`;
    print(`    正在打开控制台: ${url}`);
    void openBrowser(url);
  }
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void running.close().then(() => resolve());
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  return 0;
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const jsonMode = Boolean(flagBool(args, "json"));
  const logLevel = flagString(args, "log");
  if (logLevel) setLogLevel(logLevel as LogLevel);
  if (!jsonMode) setLogFile(null);

  const command = args.command || "status";
  try {
    switch (command) {
      case "status":
        return await commandStatus(jsonMode);
      case "locales":
        return await commandLocales(jsonMode);
      case "plan":
        return await commandPlan(args, jsonMode);
      case "apply": {
        const config = await loadConfig();
        const locale = flagString(args, "locale") ?? args.positionals[0] ?? config.defaultLocale;
        const modules = parseModules(flagString(args, "modules"));
        const restartClient = flagBool(args, "restart") ?? true;
        if (!jsonMode) print(`[*] 正在切换 ${locale}（${(modules ?? ["lobby_voice", "ingame_voice", "ingame_lang"]).join(" + ")}）…`);
        return await runTask(jsonMode, () => startApplyTask({ locale, modules, restartClient }));
      }
      case "restore": {
        const modules = parseModules(flagString(args, "modules"));
        const restartClient = flagBool(args, "restart") ?? true;
        if (!jsonMode) print("[*] 正在恢复官方默认…");
        return await runTask(jsonMode, () => startRestoreTask({ modules, restartClient }));
      }
      case "oneclick": {
        const action = args.positionals[0] ?? "apply";
        const config = await loadConfig();
        const locale = flagString(args, "locale") ?? config.defaultLocale;
        if (action === "restore" || action === "china") {
          if (!jsonMode) print("[*] 一键恢复官方国服默认…");
          return await runTask(jsonMode, () => startRestoreTask({ restartClient: true }));
        }
        if (!jsonMode) print(`[*] 一键开启全套 ${locale}…`);
        return await runTask(jsonMode, () => startApplyTask({ locale, modules: ["lobby_voice", "ingame_voice", "ingame_lang"], restartClient: true }));
      }
      case "update": {
        const action = args.positionals[0] ?? "check";
        if (action === "run" || action === "sync") {
          if (!jsonMode) print("[*] 开始增量同步语言包…");
          return await runTask(jsonMode, () => startUpdateRunTask({ locales: flagString(args, "locales")?.split(",") }));
        }
        return await runTask(jsonMode, () => startUpdateCheckTask());
      }
      case "serve":
        return await commandServe(args);
      case "doctor": {
        const info = await doctor();
        print(JSON.stringify(info, null, 2));
        return 0;
      }
      case "paths": {
        const payload = await inspectPaths();
        print(JSON.stringify(payload, null, 2));
        return 0;
      }
      case "config": {
        const action = args.positionals[0] ?? "get";
        if (action === "path") {
          print(configPath());
          return 0;
        }
        if (action === "set") {
          const pair = args.positionals[1];
          if (!pair || !pair.includes("=")) {
            print("[-] 用法: config set key=value");
            return 1;
          }
          const index = pair.indexOf("=");
          const key = pair.slice(0, index);
          const rawValue = pair.slice(index + 1);
          let value: unknown = rawValue;
          if (rawValue === "true" || rawValue === "false") value = rawValue === "true";
          else if (/^-?\d+$/.test(rawValue)) value = Number(rawValue);
          else if (rawValue.startsWith("[") || rawValue.startsWith("{")) {
            try {
              value = JSON.parse(rawValue);
            } catch {
              value = rawValue;
            }
          }
          await updateConfig({ [key]: value } as never);
          print(`[+] 已写入 ${key} = ${JSON.stringify(value)}`);
          return 0;
        }
        if (action === "reset") {
          await saveConfig(await loadConfig(true));
          print("[+] 配置已重写");
          return 0;
        }
        const config = await loadConfig();
        print(JSON.stringify({ path: configPath(), appRoot: appRoot(), config }, null, 2));
        return 0;
      }
      default:
        print(`未知命令: ${command}`);
        printHelp();
        return 1;
    }
  } catch (error) {
    print(`[-] ${String((error as Error).message ?? error)}`);
    return 1;
  }
}

export function printHelp(): void {
  print(`${APP_NAME_CN} v${APP_VERSION}`);
  print("");
  print("用法: league-voice <命令> [选项]");
  print("");
  print("命令:");
  print("  status                     显示路径与对局端/大厅端当前状态");
  print("  locales                    列出可用语言包及其资源齐备情况");
  print("  plan [--locale ja_JP]      切换前干跑预检(只读, 不改文件)");
  print("  apply [--locale ja_JP]     切换语音包/语言包 [--modules lobby_voice,ingame_voice,ingame_lang] [--restart=false]");
  print("  restore                    恢复官方国服默认 [--modules ...] [--restart=false]");
  print("  oneclick apply|restore     一键全套 / 一键还原");
  print("  update check|run           检查更新 / 增量同步语言包 [--locales ja_JP,ko_KR]");
  print("  paths                      探测所有可能的游戏安装路径");
  print("  doctor                     环境自检(路径/进程/语种/语言包)");
  print("  config [get|set k=v|path]  查看或修改配置");
  print("  serve [--host 127.0.0.1] [--port 43110]   启动后端 API 服务");
  print("");
  print("全局选项: --json(机器可读输出)  --log debug|info|warn|error");
}
