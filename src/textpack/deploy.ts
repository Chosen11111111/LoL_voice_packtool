/**
 * 客户端界面文字翻译 —— 部署。
 *
 * 范围: 只作用于英雄联盟**客户端**界面。客户端是客户端, 局内是局内 ——
 * 本模块装的是"C++ 注入核心 + 一个 JS 插件", 只注入客户端的两个浏览器进程
 * (LeagueClientUx / LeagueClientUxRender), 与局内游戏无关。
 *
 * 做什么:
 *   1. 把官方 core.dll(未修改) + 配置 + 选定的语言插件复制到本地目录(不需要管理员);
 *   2. 生成 install.cmd / uninstall.cmd(可读、可审计), 需要管理员时由界面触发 UAC 执行;
 *   3. 读取注册表判断是否已激活(读注册表不需要管理员)。
 *
 * 为什么发 core.dll 而不是整套 Pengu: 发行包里真正必需的只有这一个 455 KB 的文件,
 * 启动器(4 MB 的 WPF 界面)在游戏期间根本不需要运行。许可为 MIT, 原样收录并附声明。
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isClientRunning, killClientUx } from "../core/win/processes.ts";

/** 装到用户目录, 而不是软件目录 —— 软件可能装在只读位置。 */
export function loaderDir(): string {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "LoL_Voice", "loader");
}

/** 软件包内的资源目录(core.dll 与字典都在这里)。 */
export function assetDir(): string {
  return path.join(import.meta.dirname, "..", "..", "assets");
}

/** 激活用的注册表位置: 把 LeagueClientUx.exe 的调试器换成 rundll32 调用 core.dll。 */
export const IFEO_KEY =
  "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\LeagueClientUx.exe";

/** 写进注册表的 Debugger 值。 */
export function debuggerValue(dir: string): string {
  return `rundll32 "${path.join(dir, "core.dll")}", #6000`;
}

/**
 * 加载器的 datastore 文件是**异或混淆**过的(源码 core/src/renderer/v8_datastore.cc 里
 * transform_data(): buffer[i] ^= key[i % len], key = "A5dgY6lz9fpG9kGNiH1mZ")。
 * 我们要读它, 就得照抄这个异或 —— 只读不写, 免得不小心抹掉别的插件的数据。
 */
const DATASTORE_KEY = "A5dgY6lz9fpG9kGNiH1mZ";

function transformData(buffer: Buffer): Buffer {
  const out = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i += 1) out[i] = buffer[i]! ^ DATASTORE_KEY.charCodeAt(i % DATASTORE_KEY.length);
  return out;
}

/** 把加载器的 datastore 整个读出来(异或解密后是 JSON 对象)。 */
export async function readDatastoreMap(): Promise<Record<string, string>> {
  const file = path.join(loaderDir(), "datastore");
  try {
    const raw = transformData(await fs.readFile(file)).toString("utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 从加载器的 datastore 文件里把插件交上来的"没翻到"清单取回来。
 * 文件形如 {"键": "值"}(异或混淆), 我们只取自己那把键。
 */
export async function syncCollectedFromLoader(): Promise<number> {
  const file = path.join(loaderDir(), "datastore");
  let raw: string;
  try {
    raw = transformData(await fs.readFile(file)).toString("utf8");
  } catch {
    return 0;
  }
  try {
    const map = JSON.parse(raw) as Record<string, unknown>;
    const value = map["text-replacer.collected"];
    if (typeof value !== "string") return 0;
    const parsed = JSON.parse(value) as { collected?: unknown };
    if (!Array.isArray(parsed.collected)) return 0;
    const list = parsed.collected.filter((item): item is string => typeof item === "string");
    return list.length ? await mergeCollected(list) : 0;
  } catch {
    return 0;
  }
}

export interface TextPackState {
  /** 可用的目标语言(来自 assets/textpack/<语言>/plugin/index.js)。 */
  supported: string[];
  /** 已装到本地的语言("" = 没装)。 */
  staged: string;
  /** 注册表激活项的状态。 */
  registry: "set" | "missing" | "unknown";
  /** 装好且已激活。 */
  active: boolean;
  /** 英雄联盟客户端此刻是否在运行 —— 注入发生在客户端启动时, 所以运行中必须重启一次才生效。 */
  clientRunning: boolean;
  dir: string;
  message: string;
}

/** 扫描随包分发的语言插件。 */
export async function supportedLocales(): Promise<string[]> {
  const base = path.join(assetDir(), "textpack");
  try {
    const entries = await fs.readdir(base, { withFileTypes: true });
    const found: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "plugin") continue;
      const plugin = path.join(base, entry.name, "plugin", "index.js");
      if (await fs.stat(plugin).then(() => true).catch(() => false)) found.push(entry.name);
    }
    return found.sort();
  } catch {
    return [];
  }
}

/** 读取注册表里的激活项(只读, 不需要管理员)。 */
export async function readRegistry(): Promise<"set" | "missing" | "unknown"> {
  return new Promise((resolve) => {
    const child = spawn("reg", ["query", IFEO_KEY, "/v", "Debugger"], { windowsHide: true });
    let out = "";
    child.stdout?.on("data", (chunk) => { out += String(chunk); });
    child.on("error", () => resolve("unknown"));
    child.on("close", (code) => {
      if (code === 0 && /Debugger\s+REG_SZ/i.test(out)) resolve("set");
      else if (code === 1) resolve("missing");
      else resolve("unknown");
    });
  });
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true).catch(() => false);
}

export async function getState(): Promise<TextPackState> {
  const dir = loaderDir();
  await syncCollectedFromLoader().catch(() => 0);   // 顺手把插件交上来的清单收下来
  const supported = await supportedLocales();
  const registry = await readRegistry();
  let staged = "";
  const marker = path.join(dir, "locale.txt");
  if (await exists(path.join(dir, "core.dll"))) {
    staged = ((await fs.readFile(marker, "utf8").catch(() => "")) || "").trim();
  }
  const active = registry === "set" && staged !== "";
  const clientRunning = await isClientRunning();
  const message = active
    ? clientRunning
      ? `已开启（目标语言 ${staged}）—— 客户端正在运行, 重启客户端后才会生效`
      : `已开启（目标语言 ${staged}）—— 下次启动客户端时生效`
    : staged
      ? "已复制文件, 但还没激活（需要管理员权限写一次注册表）"
      : "未开启";
  return { supported, staged, registry, active, clientRunning, dir, message };
}

/** 配置文件: 关掉它会往客户端追加的那批 Chromium 开关(含 --no-sandbox), 也不要热键。 */
function configText(): string {
  return [
    "# LoL Voice 客户端文字翻译 —— 使用官方 Pengu Loader 的 core.dll(未修改)",
    "# 关掉默认开启的 optimized_client: 它会向客户端追加一批 Chromium 开关(含 --no-sandbox),",
    "# 我们只借用「把插件注入页面」这一个能力, 不需要它改动客户端的启动方式。",
    "optimized_client=false",
    "use_hotkeys=false",
    ""
  ].join("\r\n");
}

function scripts(dir: string): { install: string; uninstall: string } {
  const value = debuggerValue(dir).replace(/"/g, '\\"');
  const key = IFEO_KEY.replace(/\\\\/g, "\\");
  return {
    install: [
      "@echo off",
      "chcp 65001 >nul",
      "rem 由 LoL Voice 生成: 只写一个注册表项, 让 core.dll 能在客户端启动时注入我们的文字插件",
      `reg add "${key}" /v Debugger /t REG_SZ /d "${value}" /f`,
      "if errorlevel 1 (echo 激活失败 & exit /b 1)",
      "echo 已开启客户端文字翻译（重启客户端后生效）",
      "exit /b 0",
      ""
    ].join("\r\n"),
    uninstall: [
      "@echo off",
      "chcp 65001 >nul",
      "rem 由 LoL Voice 生成: 删除激活项, 客户端恢复原样",
      `reg delete "${key}" /v Debugger /f`,
      "echo 已关闭客户端文字翻译",
      "exit /b 0",
      ""
    ].join("\r\n")
  };
}

export interface StageResult {
  ok: boolean;
  dir: string;
  locale: string;
  message: string;
}

/** 复制文件(不需要管理员)。真正的激活要另一个提权步骤。 */
export async function stage(locale: string): Promise<StageResult> {
  const dir = loaderDir();
  const source = path.join(assetDir(), "textpack", locale, "plugin", "index.js");
  const core = path.join(assetDir(), "loader", "core.dll");
  if (!(await exists(source))) return { ok: false, dir, locale, message: `没有 ${locale} 的语言插件` };
  if (!(await exists(core))) return { ok: false, dir, locale, message: "软件包里的 core.dll 缺失" };
  const locked: string[] = [];
  /** 单个文件复制失败(最常见是被正在运行的客户端占用)时跳过, 不要整个流程失败。 */
  async function put(from: string, to: string, label: string): Promise<void> {
    try {
      await fs.copyFile(from, to);
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException).code ?? "");
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") locked.push(label);
      else throw error;
    }
  }
  try {
    await fs.mkdir(path.join(dir, "plugins", "text-replacer"), { recursive: true });
    // 先放插件: 它才是"要更新的东西"; core.dll 只在客户端没开着时才可能被替换
    await fs.writeFile(path.join(dir, "plugins", "text-replacer", "index.js"), await fs.readFile(source));
    await put(core, path.join(dir, "core.dll"), "core.dll（客户端正在运行，已跳过）");
    await fs.writeFile(path.join(dir, "config"), configText(), "utf8");
    await fs.writeFile(path.join(dir, "locale.txt"), locale + "\n", "utf8");
    const { install, uninstall } = scripts(dir);
    await fs.writeFile(path.join(dir, "install.cmd"), install, "utf8");
    await fs.writeFile(path.join(dir, "uninstall.cmd"), uninstall, "utf8");
    const note = locked.length ? `（${locked.join("、")} 被占用，重启客户端后可再点一次）` : "";
    return { ok: true, dir, locale, message: `文件已复制${note}，接着需要管理员权限激活一次` };
  } catch (error) {
    return { ok: false, dir, locale, message: `复制失败: ${String((error as Error).message).slice(0, 120)}` };
  }
}

/**
 * 只部署**加载器本体**(core.dll + 激活脚本), 不放任何插件。
 * 选人语音插件用这条: 它和文字翻译共用同一个加载器, 谁先开都能用。
 */
export async function stageLoader(): Promise<{ ok: boolean; dir: string; message: string; locked: string[] }> {
  const dir = loaderDir();
  const core = path.join(assetDir(), "loader", "core.dll");
  if (!(await exists(core))) return { ok: false, dir, message: "软件包里的 core.dll 缺失", locked: [] };
  const locked: string[] = [];
  try {
    await fs.mkdir(path.join(dir, "plugins"), { recursive: true });
    try {
      await fs.copyFile(core, path.join(dir, "core.dll"));
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException).code ?? "");
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") locked.push("core.dll（客户端正在运行，已跳过）");
      else throw error;
    }
    if (!(await exists(path.join(dir, "config")))) await fs.writeFile(path.join(dir, "config"), configText(), "utf8");
    const { install, uninstall } = scripts(dir);
    await fs.writeFile(path.join(dir, "install.cmd"), install, "utf8");
    await fs.writeFile(path.join(dir, "uninstall.cmd"), uninstall, "utf8");
    return { ok: true, dir, message: "加载器已就位", locked };
  } catch (error) {
    return { ok: false, dir, message: `复制加载器失败：${String((error as Error).message).slice(0, 120)}`, locked };
  }
}

/**
 * 只删我们自己放的文件; 目录里有别的东西就留着(绝不误删用户的文件)。
 *
 * keepLoader = true 时**不删 core.dll / 激活脚本**: 加载器是和"选人语音"共用的,
 * 只还原文字翻译却把加载器拆了, 选人语音的插件就再也注入不进去了(踩过这个坑)。
 */
export async function unstage(options: { keepLoader?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
  const dir = loaderDir();
  try {
    await fs.rm(path.join(dir, "plugins", "text-replacer"), { recursive: true, force: true });
    // 许可声明两个名字留着: 早先版本装过, 这里顺手清掉
    const names = options.keepLoader
      ? ["locale.txt", "LICENSE-pengu.txt", "NOTICE.txt"]
      : ["core.dll", "config", "locale.txt", "LICENSE-pengu.txt", "NOTICE.txt", "install.cmd", "uninstall.cmd"];
    for (const name of names) {
      await fs.rm(path.join(dir, name), { force: true });
    }
    // 目录空了就一起删掉, 做到"一键卸干净"; 父目录(LoL_Voice)绝对不动, 那里还有界面内核的运行目录
    const left = await fs.readdir(dir).catch(() => [] as string[]);
    if (left.length === 0) await fs.rmdir(dir).catch(() => undefined);
    return { ok: true, message: "已移除本地文件" };
  } catch (error) {
    return { ok: false, message: `移除失败: ${String((error as Error).message).slice(0, 120)}` };
  }
}

/** 插件在客户端里"看到但没翻到"的中文清单, 攒在这里供之后补字典。 */
export async function mergeCollected(list: string[]): Promise<number> {
  const file = path.join(loaderDir(), "collected.json");
  const known = new Set<string>();
  try {
    const old = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (Array.isArray(old)) for (const item of old) if (typeof item === "string") known.add(item);
  } catch { /* 第一次没有这个文件 */ }
  const before = known.size;
  for (const item of list) if (item && item.length <= 200) known.add(item);
  try {
    await fs.mkdir(loaderDir(), { recursive: true });
    await fs.writeFile(file, JSON.stringify([...known].sort(), null, 1), "utf8");
  } catch { /* 写不进去也不影响客户端 */ }
  return known.size - before;
}

/** 重启客户端: 注入只发生在客户端启动时, 所以运行中开启后必须重启一次。 */
export async function restartClient(): Promise<{ ok: boolean; message: string }> {
  const result = await killClientUx();
  return { ok: result.ok, message: result.ok ? "已重启客户端（会重新登录一次）" : result.message };
}

/** 用 UAC 执行我们生成的那个脚本(会弹一次系统授权框)。 */
export async function runElevated(script: "install" | "uninstall"): Promise<{ ok: boolean; message: string }> {
  const file = path.join(loaderDir(), script + ".cmd");
  if (!(await exists(file))) return { ok: false, message: "找不到脚本, 请先复制文件" };
  // 取消激活时如果本来就没激活, 不必弹 UAC
  if (script === "uninstall" && (await readRegistry()) === "missing") {
    return { ok: true, message: "本来就没有激活, 不需要授权" };
  }
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Start-Process -FilePath '${file}' -Verb RunAs -Wait`], { windowsHide: true });
    child.on("error", (error) => resolve({ ok: false, message: String(error.message).slice(0, 120) }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, message: script === "install" ? "已激活" : "已取消激活" });
      else resolve({ ok: false, message: "授权被取消或写入失败" });
    });
  });
}
