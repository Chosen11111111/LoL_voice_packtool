/** REST API: 界面(未来任意前端)只需对着这一组接口写。 */
import path from "node:path";
import os from "node:os";
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { APP_NAME, APP_NAME_CN, APP_VERSION, API_VERSION } from "../version.ts";
import { saveConfig, loadConfig, appRoot, configPath, type ConfigPatch } from "../core/config.ts";
import { resolveVoiceRoot } from "../core/paths.ts";
import { isDirectory, listNames } from "../core/fsx.ts";
import { getState as getTextPackState, mergeCollected, restartClient as restartClientForTextPack, runElevated, stage as stageTextPack, unstage as unstageTextPack } from "../textpack/deploy.ts";
import { isClientRunning } from "../core/win/processes.ts";
import type { ModuleId } from "../core/types.ts";
import { invalidateConfigCache } from "../core/config.ts";
import { createLogger, setLogLevel, type LogLevel } from "../core/logger.ts";
import {
  clientVoiceState,
  readAudioSettings,
  readVolumes,
  recoverOnStartup,
  setAutoSuppress,
  setClientOriginalVoice
} from "../modules/clientVoice.ts";

/** 是否有人要求把主窗口叫回来(双击图标时由启动器触发)。 */
let windowShowRequested = false;

/** 取一次就清掉: 页面拿到后才会执行, 不需要重复执行。 */
function takeWindowShowRequest(): boolean {
  const value = windowShowRequested;
  windowShowRequested = false;
  return value;
}

const logger = createLogger("api");
import { Router, startHttpServer, type RunningServer } from "./http.ts";
import { taskManager, type TaskEvent } from "../tasks/manager.ts";
import { SUPPORTED_EXTENSIONS } from "../packs/archive.ts";
import {
  buildEnvFromConfig,
  clientInfoPayload,
  doctor,
  getDashboard,
  getLocales,
  inspectPaths,
  planSwitch,
  startApplyTask,
  startImportTask,
  startRestoreTask,
  updateConfig
} from "../service.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asModules(value: unknown): ModuleId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed: ModuleId[] = ["lobby_voice", "ingame_voice", "ingame_lang", "lobby_lang"];
  const modules = value.filter((item): item is ModuleId => typeof item === "string" && allowed.includes(item as ModuleId));
  return modules.length ? modules : undefined;
}

/**
 * 这些模块需要英雄联盟客户端在运行(选人语音必须连 LCU, 客户端没开就做不了)。
 * 对局语音/对局语言只改游戏文件, 不在此列。
 */
function needsClient(modules: ModuleId[] | null | undefined): boolean {
  return Array.isArray(modules) && modules.some((item) => item === "lobby_voice" || item === "lobby_lang");
}

export function buildRouter(): Router {
  const router = new Router();

  router.get("/api/health", () => ({
    ok: true,
    app: APP_NAME,
    app_cn: APP_NAME_CN,
    version: APP_VERSION,
    api_version: API_VERSION,
    node: process.version,
    uptime_s: Math.round(process.uptime()),
    tasks_running: taskManager.list().filter((task) => task.status === "running").length,
    sse_clients: router.sseCount
  }));

  router.get("/api/state", async () => {
    const config = await loadConfig();
    return {
      ok: true,
      state: {
        ...(await getDashboard()),
        // 上次"开启语音包"的记录: 选人语音的开关只看这个状态(勾选框不算)
        last_applied: config.ui?.lastApplied ?? null,
        release: process.env.LEAGUE_VOICE_RELEASE === "1",
        hide_enable_tip: config.ui?.hideEnableTip === true,
        hide_tray_tip: config.ui?.hideTrayTip === true,
        window_show: takeWindowShowRequest()
      }
    };
  });

  /**
   * 品牌图等静态素材: <软件目录>/assets/<路径>。避免为了显示一张图去复制一份到 web/。
   * 支持子目录(例如 ico/voicepack-icon-512.png); 只允许图片扩展名, 并且禁止任何 ..
   * —— 请求路径先过白名单正则, 再校验解析后的绝对路径确实落在 assets 里。
   */
  const serveBrandAsset = async (context: { params: Record<string, string>; res: import("node:http").ServerResponse }) => {
    // 支持 assets/ico/xxx.png 这样的一层子目录
    const name = [context.params.dir, context.params.file].filter(Boolean).join("/").replace(/\\/g, "/");
    if (!/^[\w][\w./-]*\.(png|jpg|jpeg|webp|gif|svg|ico)$/i.test(name) || name.includes("..")) {
      return { ok: false, error: "bad_request", message: "不支持的素材路径" };
    }
    const assetsRoot = path.join(appRoot(), "assets");
    const file = path.resolve(assetsRoot, name);
    if (!file.startsWith(assetsRoot + path.sep)) {
      return { ok: false, error: "bad_request", message: "素材路径越界" };
    }
    const data = await readFile(file).catch(() => null);
    if (!data) {
      context.res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      context.res.end(JSON.stringify({ ok: false, error: "not_found", message: `没有这个素材：${file}` }));
      return undefined;
    }
    const ext = path.extname(name).toLowerCase();
    const type =
      ext === ".png" ? "image/png" : ext === ".svg" ? "image/svg+xml" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
    context.res.writeHead(200, { "Content-Type": type, "Content-Length": data.length, "Cache-Control": "no-cache" });
    context.res.end(data);
    return undefined;
  };
  // 路由器按"段数"精确匹配, 所以一段(assets/xx.png)和两段(assets/ico/xx.png)各注册一条
  router.get("/brand/:file", serveBrandAsset);
  router.get("/brand/:dir/:file", serveBrandAsset);


  router.get("/api/client-voice", async () => ({ ok: true, ...(await clientVoiceState()) }));

  /**
   * 静音/恢复客户端原版选人台词。
   * body.auto 存在时切换"选人期间自动静音"闭环; 否则按 body.suppressed 手动静音/还原。
   */
  router.post("/api/client-voice", async (context) => {
    const body = asRecord(context.body);
    if (body.auto !== undefined) {
      const result = await setAutoSuppress(body.auto !== false);
      return { ok: result.ok, ...result.state, message: result.message };
    }
    const suppress = body.suppressed !== false;
    const result = await setClientOriginalVoice(suppress);
    return { ok: result.ok, ...result.state, message: result.message };
  });

  /**
   * 客户端界面文字翻译(只改客户端, 不动局内)。
   * GET  看状态; POST 分四步: stage 复制文件 / activate 提权激活 / deactivate 取消激活 / unstage 移除文件。
   */
  router.get("/api/textpack", async () => ({ ok: true, state: await getTextPackState() }));

  /**
   * 客户端里的插件把"看到但没翻到"的中文报回来(用 text/plain 发, 避免跨域预检)。
   * 这是把界面改彻底的关键: 攒够一份真实清单, 才能知道还差哪些词。
   */
  router.postRaw("/api/textpack/collect", async (context) => {
    let text = "";
    try {
      if (context.rawFile) text = await readFile(context.rawFile, "utf8");
      else if (typeof context.body === "string") text = context.body;
    } catch { /* 忽略 */ }
    const list: string[] = [];
    try {
      const parsed = JSON.parse(text) as { collected?: unknown };
      if (Array.isArray(parsed.collected)) for (const item of parsed.collected) if (typeof item === "string") list.push(item);
    } catch { /* 不是 JSON 就算了 */ }
    const added = list.length ? await mergeCollected(list) : 0;
    return { ok: true, received: list.length, added };
  });

  router.post("/api/textpack", async (context) => {
    const body = asRecord(context.body);
    const action = String(body.action ?? "");
    const locale = String(body.locale ?? "en_us");
    if (action === "stage") {
      const result = await stageTextPack(locale);
      return { ok: result.ok, message: result.message, state: await getTextPackState() };
    }
    if (action === "activate" || action === "deactivate") {
      const result = await runElevated(action === "activate" ? "install" : "uninstall");
      return { ok: result.ok, message: result.message, state: await getTextPackState() };
    }
    if (action === "unstage") {
      const result = await unstageTextPack();
      return { ok: result.ok, message: result.message, state: await getTextPackState() };
    }
    if (action === "restart") {
      const result = await restartClientForTextPack();
      return { ok: result.ok, message: result.message, state: await getTextPackState() };
    }
    return { ok: false, message: "未知操作: " + action, state: await getTextPackState() };
  });


  router.get("/api/client", async () => {
    const config = await loadConfig();
    const env = await buildEnvFromConfig(config);
    return { ok: true, ...clientInfoPayload(env) };
  });

  router.get("/api/locales", async (context) => {
    const stats = context.query.get("stats");
    const payload = await getLocales({ withCounts: stats !== "0" });
    return { ok: true, ...payload };
  });

  router.get("/api/paths", async () => ({ ok: true, ...(await inspectPaths()) }));

  router.get("/api/config", async () => ({ ok: true, config: await loadConfig(), path: configPath() }));

  router.put("/api/config", async (context) => {
    const patch = asRecord(context.body) as ConfigPatch;
    const config = await updateConfig(patch);
    invalidateConfigCache();
    if (typeof patch.logLevel === "string") setLogLevel(patch.logLevel as LogLevel);
    return { ok: true, config };
  });

  router.post("/api/plan", async (context) => {
    const body = asRecord(context.body);
    const config = await loadConfig();
    const locale = typeof body.locale === "string" && body.locale ? body.locale : config.defaultLocale;
    const modules = Array.isArray(body.modules) ? asModules(body.modules) ?? [] : undefined;
    return { ok: true, plan: await planSwitch({ locale, modules }) };
  });

  router.post("/api/apply", async (context) => {
    const body = asRecord(context.body);
    const config = await loadConfig();
    const locale = typeof body.locale === "string" && body.locale ? body.locale : config.defaultLocale;
    // 注意: asModules 会把空数组折成 undefined, 而 undefined 在这里的意思是"没指定, 全都要"。
    // 于是"只勾了客户端界面文字"会变成"顺手把对局语音/对局文字也切了" —— 用户实测踩到过。
    // 所以明确传了数组(哪怕是空的)就必须原样尊重。
    const modules = Array.isArray(body.modules) ? asModules(body.modules) ?? [] : undefined;
    // 设计约定: 只有勾选了"选人语音"才要求客户端在运行(它必须连 LCU);
    // 对局语音/对局语言只改游戏文件, 客户端没开也能做。恢复原版不受任何限制。
    if (needsClient(modules) && !(await isClientRunning())) {
      return {
        ok: false,
        blocked: true,
        message: "英雄联盟未启动：选人语音需要客户端运行，请先启动客户端并登录到大厅"
      };
    }
    // 客户端界面文字不是游戏模块: 它要装/卸注入器(各需要一次管理员授权), 所以在任务开始前
    // 先做掉 —— 这样任务后面那次"重启客户端"正好能让注入生效。
    // 这一步失败绝不能拖垮"开启语音包"本身: 授权被拒、文件被占用都要照常继续, 只记一条日志。
    const wantClientText = body.clientText === true;
    const clientTextLocale = typeof body.clientTextLocale === "string" ? body.clientTextLocale : "";
    try {
      const textPackBefore = await getTextPackState();
      if (wantClientText && !textPackBefore.active) {
        const staged = await stageTextPack(clientTextLocale || locale.toLowerCase());
        // 提权跑 install.cmd: 它除了写注册表, 还会关掉正在运行的客户端(注入只在启动时发生)。
        // 关闭放在脚本里是因为它已经提权, 从我们这边普通权限 taskkill 未必杀得动 WeGame 启动的客户端。
        if (staged.ok) await runElevated("install");
      } else if (!wantClientText && textPackBefore.staged) {
        await runElevated("uninstall");
        await unstageTextPack();
      }
    } catch (error) {
      logger.warn("客户端界面文字这一步没做成(不影响语音包): " + String((error as Error).message).slice(0, 120));
    }

    const task = startApplyTask({
      locale,
      modules,
      clientText: wantClientText,
      restartClient: typeof body.restartClient === "boolean" ? body.restartClient : undefined,
      lobbyLang: body.lobbyLang === "en_US" || body.lobbyLang === "zh_CN" ? body.lobbyLang : "keep"
    });
    return { ok: true, task };
  });

  /** 页面看到 window_show=true 就让外壳把窗口亮出来(读一次就清掉, 一次性)。 */
  router.post("/api/window/show", () => {
    windowShowRequested = true;
    return { ok: true };
  });

  /**
   * 用系统默认浏览器打开链接。
   * 为什么不让页面直接 window.open: 外壳(WebView2)没有处理"新窗口"请求, 点了没有任何反应。
   * 只接受 http/https, 免得这个接口被拿去做别的事。
   */
  router.post("/api/open-url", async (context) => {
    const body = asRecord(context.body);
    const url = String(body.url ?? "").trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return { ok: false, message: "只支持 http/https 链接" };
    try {
      const { spawn } = await import("node:child_process");
      // 用 rundll32 而不是 cmd /c start: 它是图形程序, 不会闪出一个黑色控制台窗口。
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
      return { ok: true, message: "已用系统浏览器打开" };
    } catch (error) {
      return { ok: false, message: "打开失败: " + String((error as Error).message).slice(0, 120) };
    }
  });

  /** 记住"托盘的说明已经看过"。 */
  router.post("/api/ui/hide-tray-tip", async () => {
    await saveConfig({ ui: { hideTrayTip: true } });
    return { ok: true };
  });

  /** 记住『不再提醒』: 只在用户明确点了那个按钮时才写。 */
  router.post("/api/ui/hide-enable-tip", async () => {
    await saveConfig({ ui: { hideEnableTip: true } });
    return { ok: true };
  });

  router.post("/api/restore", async (context) => {
    // "恢复原版"要把它也还原: 先取消激活(删注册表项, 需要管理员), 再删掉我们放进去的文件。
    // 顺序不能反 —— 先删文件的话注册表还指着不存在的 core.dll, 客户端会启动不了。
    let removedTextPack = false;
    const textPack = await getTextPackState();
    if (textPack.staged) {
      await runElevated("uninstall");
      await unstageTextPack();
      removedTextPack = true;
      logger.info("恢复原版: 客户端界面文字已还原");
    }
    const body = asRecord(context.body);
    const task = startRestoreTask({
      modules: asModules(body.modules),
      // 撤过文字包就要重启客户端: 运行中的客户端里注入器还挂着, 不重启等于没还原。
      clientText: removedTextPack,
      restartClient: typeof body.restartClient === "boolean" ? body.restartClient : undefined,
    });
    return { ok: true, task };
  });

  router.post("/api/oneclick/apply", async (context) => {
    const body = asRecord(context.body);
    const config = await loadConfig();
    const locale = typeof body.locale === "string" && body.locale ? body.locale : config.defaultLocale;
    const oneClickModules = asModules(body.modules) ?? ["lobby_voice", "ingame_voice", "ingame_lang"];
    if (needsClient(oneClickModules) && !(await isClientRunning())) {
      return {
        ok: false,
        blocked: true,
        message: "英雄联盟未启动：一键开启包含选人语音，请先启动客户端并登录到大厅"
      };
    }
    const task = startApplyTask({
      locale,
      modules: oneClickModules,
      restartClient: typeof body.restartClient === "boolean" ? body.restartClient : true,
      lobbyLang: body.lobbyLang === "en_US" ? "en_US" : "keep"
    });
    return { ok: true, task };
  });

  router.post("/api/oneclick/restore", async (context) => {
    const body = asRecord(context.body);
    const task = startRestoreTask({
      modules: asModules(body.modules) ?? ["lobby_voice", "lobby_lang", "ingame_voice", "ingame_lang"],
      restartClient: typeof body.restartClient === "boolean" ? body.restartClient : true,
    });
    return { ok: true, task };
  });

  /**
   * 导入语音包压缩包。
   * - 二进制上传: POST 原始文件内容 + ?name=xxx.zip[&locale=ja_JP][&overwrite=1]
   * - 本地文件:   POST JSON { "path": "E:\\packs\\jp.zip", "locale": "", "overwrite": false }
   * 长任务, 返回 task; 装完后会自动出现在 GET /api/locales 里。
   */
  router.postRaw("/api/packs/import", async (context) => {
    const body = asRecord(context.body);
    const query = context.query;
    const uploadName = (query.get("name") ?? "").trim();
    const locale = (query.get("locale") ?? body.locale ?? "").toString().trim();
    const overwrite = ["1", "true", "yes", "on"].includes(String(query.get("overwrite") ?? body.overwrite ?? "").toLowerCase());

    let archive = "";
    let deleteAfter = false;
    const name = context.rawFile ? uploadName || "pack.zip" : String(body.path ?? "").trim();
    // 允许直接给"已经解开的文件夹"(不需要任何解压工具, 也不用经过浏览器上传)
    const givenDir = !context.rawFile && name ? await isDirectory(name) : false;
    const extension = SUPPORTED_EXTENSIONS.find((ext) => name.toLowerCase().endsWith(ext));
    if (!context.rawFile && !givenDir && !extension) {
      return { ok: false, error: "bad_request", message: `不支持的格式：${path.basename(name)}（支持 ${SUPPORTED_EXTENSIONS.join(" / ")}，也可以直接选已解开的文件夹）` };
    }
    if (context.rawFile) {
      // 上传的临时文件移交给后台任务(同卷改名), 避免任务还没跑就被清掉
      const keepDir = path.join(appRoot(), ".tmp", "imports");
      await mkdir(keepDir, { recursive: true });
      const ext = name.toLowerCase().endsWith(".tar.gz") ? ".tar.gz" : extension;
      const owned = path.join(keepDir, `pack-${randomUUID()}${ext}`);
      try {
        await rename(context.rawFile, owned);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        try { await copyFile(context.rawFile, owned); }
        catch (copyError) { await rm(owned, { force: true }).catch(() => undefined); throw copyError; }
      }
      archive = owned;
      deleteAfter = true;
    } else {
      archive = String(body.path ?? "").trim();
    }

    if (!archive) {
      return { ok: false, error: "bad_request", message: "缺少压缩包：请上传文件内容，或在 JSON 里给出 path" };
    }
    if (!SUPPORTED_EXTENSIONS.some((ext) => archive.toLowerCase().endsWith(ext))) {
      return {
        ok: false,
        error: "bad_request",
        message: `不支持的格式：${path.basename(archive)}（支持 ${SUPPORTED_EXTENSIONS.join(" / ")}）`
      };
    }
    try { return { ok: true, task: startImportTask({ archive, archiveName: context.rawFile ? name : undefined, locale, overwrite, deleteAfter }) }; }
    catch (error) {
      if (deleteAfter) await rm(archive, { force: true }).catch(() => undefined);
      throw error;
    }
  });

  /**
   * 找本机现成的语音包压缩包(下载目录/桌面/文档/软件目录), 供界面"从路径导入"一键选中。
   * 这样就不用把几个 GB 通过浏览器上传给后端 —— 直接读路径, 快得多。
   */
  router.get("/api/packs/local-files", async () => {
    const home = process.env["USERPROFILE"] ?? os.homedir();
    const dirs = [
      path.join(home, "Downloads"),
      path.join(home, "Desktop"),
      path.join(home, "Documents"),
      appRoot()
    ];
    const files: Array<{ path: string; name: string; size: number; at: number }> = [];
    for (const dir of dirs) {
      if (!(await isDirectory(dir))) continue;
      for (const name of await listNames(dir)) {
        const lower = name.toLowerCase();
        if (!SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;
        const full = path.join(dir, name);
        const info = await stat(full).catch(() => null);
        if (!info?.isFile()) continue;
        files.push({ path: full, name, size: info.size, at: info.mtimeMs });
      }
    }
    files.sort((a, b) => b.at - a.at);
    return { ok: true, files: files.slice(0, 20) };
  });

  router.post("/api/doctor", async () => ({ ok: true, doctor: await doctor() }));

  router.get("/api/tasks", () => ({ ok: true, tasks: taskManager.list(), busy: taskManager.busyGroups() }));

  router.get("/api/tasks/:id", (context) => {
    const record = taskManager.get(context.params.id!);
    if (!record) return { ok: false, error: "not_found", message: "任务不存在" };
    return {
      ok: true,
      task: taskManager.snapshot(record),
      result: record.result ?? null,
      logs: record.events.filter((event) => event.type === "log").map((event) => (event as { line: string }).line)
    };
  });

  router.post("/api/tasks/:id/cancel", (context) => {
    const cancelled = taskManager.cancel(context.params.id!);
    return { ok: cancelled, message: cancelled ? "已请求取消" : "任务不存在或已结束" };
  });

  return router;
}

export interface ApiServerOptions {
  host?: string;
  port?: number;
  token?: string;
}

/** 启动 API 服务(端口 0 = 随机分配, 便于测试)。 */
export async function startApiServer(
  options: ApiServerOptions = {}
): Promise<{ running: RunningServer; router: Router; staticDir: string | null }> {
  const config = await loadConfig();
  const host = options.host ?? config.server.host;
  const port = options.port ?? config.server.port;
  const token = options.token ?? (host === "127.0.0.1" || host === "localhost" ? config.server.token : config.server.token || "");
  const router = buildRouter();

  // 启动兜底: 上次若被本工具静音过、但这次并没有在监听选人语音, 把原版台词还原回去
  // (客户端设置是持久化的, 不还原会一直留在静音状态)
  void recoverOnStartup(false);

  // 前端目录: 绝对路径直接用, 相对路径相对项目根
  const webDir = (config.server.webDir ?? "web").trim();
  const staticDir = webDir ? (path.isAbsolute(webDir) ? webDir : path.join(appRoot(), webDir)) : "";
  const hasWeb = staticDir ? await isDirectory(staticDir) : false;

  const running = await startHttpServer({
    host,
    port,
    token,
    router,
    staticDir: hasWeb ? staticDir : undefined,
    spaFallback: hasWeb,
    maxUploadBytes: config.server.maxUploadBytes,
    uploadDir: path.join(appRoot(), ".tmp", "uploads")
  });
  const unsubscribeTasks = taskManager.subscribe((event: TaskEvent) => router.broadcast(event.type, event));
  // 省资源: 读客户端音量是一次 LCU 的 HTTP 请求, 没必要一直每秒一次。
  // 选人阶段(最近 60 秒有事件)保持 1 秒精度, 让它"调完音量马上生效";
  // 平时 5 秒问一次就够, 空转开销降到原来的 1/5。
  let lastLobbyEventAt = 0;
  let lastVolumeProbeAt = 0;

  running.server.once("close", () => {
    unsubscribeTasks();
  });
  return { running, router, staticDir: hasWeb ? staticDir : null };
}

/** 让 CLI 也能拿到一次完整状态(不启动服务)。 */
export async function stateOnce(): Promise<unknown> {
  const config = await loadConfig();
  const env = await buildEnvFromConfig(config);
  return {
    dashboard: await getDashboard(),
    env: { voiceRoot: env.voiceRoot, baseLocale: env.baseLocale, region: env.region },
    // 上次"开启语音包"的记录: 重启后界面据此说明当前生效的是什么
    last_applied: config.ui?.lastApplied ?? null,
        release: process.env.LEAGUE_VOICE_RELEASE === "1",
        hide_enable_tip: config.ui?.hideEnableTip === true,
        hide_tray_tip: config.ui?.hideTrayTip === true,
        window_show: takeWindowShowRequest()
  };
}
