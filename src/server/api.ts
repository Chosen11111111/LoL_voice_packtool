/** REST API: 界面(未来任意前端)只需对着这一组接口写。 */
import path from "node:path";
import { copyFile, mkdir, readFile, rename } from "node:fs/promises";
import { APP_NAME, APP_NAME_CN, APP_VERSION, API_VERSION } from "../version.ts";
import { loadConfig, appRoot, type AppConfig } from "../core/config.ts";
import { resolveVoiceRoot } from "../core/paths.ts";
import { lobbyLive } from "../modules/lobbyLive.ts";
import { isDirectory } from "../core/fsx.ts";
import type { ModuleId } from "../core/types.ts";
import { invalidateConfigCache } from "../core/config.ts";
import { createLogger, setLogLevel, type LogLevel } from "../core/logger.ts";
import { clientVoiceState, recoverOnStartup, setAutoSuppress, setClientOriginalVoice } from "../modules/clientVoice.ts";

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
  startUpdateCheckTask,
  startUpdateRunTask,
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

  router.get("/api/state", async () => ({ ok: true, state: { ...(await getDashboard()), lobby_live: lobbyLive.state() } }));

  /* ------------------------------------------------ 选人语音实时播报 */

  /** 工具窗口播放的音频来源: <资源根>/<语种>/assets/champion-{choose,ban}-vo/<id>.ogg */
  router.get("/api/lobby-audio/:kind/:file", async (context) => {
    const kind = context.params.kind === "ban" ? "champion-ban-vo" : "champion-choose-vo";
    const id = Number.parseInt(String(context.params.file ?? "").replace(/\.ogg$/i, ""), 10);
    const locale = String(context.query.get("locale") ?? "");
    if (!Number.isFinite(id) || id <= 0 || !/^[a-z]{2}_[A-Z]{2}$/.test(locale)) {
      return { ok: false, error: "bad_request", message: "参数不合法" };
    }
    const config = await loadConfig();
    const root = (await resolveVoiceRoot(config, appRoot())).root;
    const file = path.join(root, locale, "assets", kind, `${id}.ogg`);
    const data = await readFile(file).catch(() => null);
    if (!data) {
      context.res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      context.res.end(JSON.stringify({ ok: false, error: "not_found", message: `语音包里没有 ${locale}/${kind}/${id}.ogg` }));
      return undefined;
    }
    logger.info(`播报音频已被窗口取用: ${locale}/${kind}/${id}.ogg（${data.length} 字节）`);
    context.res.writeHead(200, {
      "Content-Type": "audio/ogg",
      "Content-Length": data.length,
      "Cache-Control": "no-store"
    });
    context.res.end(data);
    return undefined;
  });

  router.get("/api/lobby-live/state", () => ({ ok: true, state: lobbyLive.state() }));

  router.post("/api/lobby-live/start", async (context) => {
    const body = asRecord(context.body);
    const config = await loadConfig();
    const locale = String(body.locale ?? config.defaultLocale);
    const root = (await resolveVoiceRoot(config, appRoot())).root;
    const result = await lobbyLive.start({
      voiceRoot: root,
      locale,
      includeOthers: Boolean(body.includeOthers)
    });
    return { ok: result.ok, message: result.message, state: result.state, audio_base: `/api/lobby-audio` };
  });

  /** 客户端原版选人台词(音效/音乐不受影响)的开关状态。 */
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

  /** 窗口把播放结果回报过来: 成功会记录, 失败会留下浏览器的原始错误码。 */
  router.post("/api/lobby-live/report", (context) => {
    const body = asRecord(context.body);
    lobbyLive.reportPlayback({
      ok: Boolean(body.ok),
      error: body.error ? String(body.error) : "",
      detail: body.detail ? String(body.detail) : "",
      championId: Number(body.championId ?? 0) || 0,
      kind: body.kind === "ban" ? "ban" : "choose"
    });
    return { ok: true };
  });

  router.post("/api/lobby-live/stop", async () => {
    await lobbyLive.stop();
    return { ok: true, state: lobbyLive.state() };
  });

  /** 客户端语种/渠道(国服 or 外服)与目标槽位后缀。 */
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

  router.get("/api/config", async () => ({ ok: true, config: await loadConfig(), path: path.join(appRoot(), "config.json") }));

  router.put("/api/config", async (context) => {
    const patch = asRecord(context.body) as Partial<AppConfig>;
    const config = await updateConfig(patch);
    invalidateConfigCache();
    if (typeof patch.logLevel === "string") setLogLevel(patch.logLevel as LogLevel);
    return { ok: true, config };
  });

  router.post("/api/plan", async (context) => {
    const body = asRecord(context.body);
    const config = await loadConfig();
    const locale = typeof body.locale === "string" && body.locale ? body.locale : config.defaultLocale;
    return { ok: true, plan: await planSwitch({ locale, modules: asModules(body.modules) }) };
  });

  router.post("/api/apply", async (context) => {
    const body = asRecord(context.body);
    const config = await loadConfig();
    const locale = typeof body.locale === "string" && body.locale ? body.locale : config.defaultLocale;
    const task = startApplyTask({
      locale,
      modules: asModules(body.modules),
      restartClient: typeof body.restartClient === "boolean" ? body.restartClient : undefined,
      lobbyLang: body.lobbyLang === "en_US" || body.lobbyLang === "zh_CN" ? body.lobbyLang : "keep"
    });
    return { ok: true, task };
  });

  router.post("/api/restore", async (context) => {
    const body = asRecord(context.body);
    const task = startRestoreTask({
      modules: asModules(body.modules),
      restartClient: typeof body.restartClient === "boolean" ? body.restartClient : undefined,
    });
    return { ok: true, task };
  });

  router.post("/api/oneclick/apply", async (context) => {
    const body = asRecord(context.body);
    const config = await loadConfig();
    const locale = typeof body.locale === "string" && body.locale ? body.locale : config.defaultLocale;
    const task = startApplyTask({
      locale,
      modules: asModules(body.modules) ?? ["lobby_voice", "ingame_voice", "ingame_lang"],
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
    if (context.rawFile) {
      // 上传的临时文件移交给后台任务(同卷改名), 避免任务还没跑就被清掉
      const keepDir = path.join(appRoot(), ".tmp", "imports");
      await mkdir(keepDir, { recursive: true }).catch(() => undefined);
      const ext = path.extname(uploadName || ".zip") || ".zip";
      const owned = path.join(keepDir, `pack-${Date.now()}${ext}`);
      try {
        await rename(context.rawFile, owned);
      } catch {
        await copyFile(context.rawFile, owned);
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
    return { ok: true, task: startImportTask({ archive, locale, overwrite, deleteAfter }) };
  });

  router.post("/api/update/check", () => ({ ok: true, task: startUpdateCheckTask() }));

  router.post("/api/update/run", (context) => {
    const body = asRecord(context.body);
    const locales = Array.isArray(body.locales) ? body.locales.filter((item): item is string => typeof item === "string") : undefined;
    return { ok: true, task: startUpdateRunTask({ locales }) };
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

  router.post("/api/tasks/:id/cancel", (context) => ({
    ok: taskManager.cancel(context.params.id!),
    message: taskManager.cancel(context.params.id!) ? "已请求取消" : "任务不存在或已结束"
  }));

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

  // 任务事件 -> SSE
  taskManager.subscribe((event: TaskEvent) => {
    router.broadcast(event.type, event);
  });

  // 选人语音实时播报事件 -> SSE(前端收到后用它播音频)
  lobbyLive.subscribe((event) => {
    router.broadcast("lobby", event);
  });

  // 启动兜底: 上次若被本工具静音过、但这次并没有在监听选人语音, 把原版台词还原回去
  // (客户端设置是持久化的, 不还原会一直留在静音状态)
  void recoverOnStartup(lobbyLive.isRunning());

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
    spaFallback: hasWeb
  });
  return { running, router, staticDir: hasWeb ? staticDir : null };
}

/** 让 CLI 也能拿到一次完整状态(不启动服务)。 */
export async function stateOnce(): Promise<unknown> {
  const config = await loadConfig();
  const env = await buildEnvFromConfig(config);
  return { dashboard: await getDashboard(), env: { voiceRoot: env.voiceRoot, baseLocale: env.baseLocale, region: env.region } };
}
