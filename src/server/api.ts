/** REST API: 界面(未来任意前端)只需对着这一组接口写。 */
import path from "node:path";
import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { APP_NAME, APP_NAME_CN, APP_VERSION, API_VERSION } from "../version.ts";
import { loadConfig, appRoot, configPath, type ConfigPatch } from "../core/config.ts";
import { resolveVoiceRoot } from "../core/paths.ts";
import { lobbyLive } from "../modules/lobbyLive.ts";
import { isDirectory } from "../core/fsx.ts";
import { isClientRunning } from "../core/win/processes.ts";
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
        lobby_live: lobbyLive.state(),
        // 上次"开启语音包"的记录: 选人语音的开关只看这个状态(勾选框不算)
        last_applied: config.ui?.lastApplied ?? null
      }
    };
  });

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
    // 顺带量一下"事件发生 -> 窗口来取音频"的延迟: 正常应在几十毫秒内,
    // 若出现几十秒, 就是窗口被节流了(见 app.ts 里关闭节流的启动参数)
    const lastEvent = lobbyLive.state().last_event;
    const delay = lastEvent && lastEvent.championId === id ? Date.now() - lastEvent.at : 0;
    logger.info(
      `播报音频已被窗口取用: ${locale}/${kind}/${id}.ogg（${data.length} 字节` +
        `${delay > 0 ? `，距事件 ${delay}ms` : ""}）`
    );
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

  /** 手动试听: 不开游戏也能验证"SSE -> 窗口播放 -> 音频接口"整条链路。 */
  router.post("/api/lobby-live/test", (context) => {
    const body = asRecord(context.body);
    const kind = body.kind === "ban" ? "ban" : "choose";
    const championId = Number(body.championId ?? 0) || 0;
    const result = lobbyLive.emitTest({ kind, championId });
    return { ok: result.ok, message: result.message };
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
    return { ok: true, plan: await planSwitch({ locale, modules: asModules(body.modules) }) };
  });

  router.post("/api/apply", async (context) => {
    const body = asRecord(context.body);
    const config = await loadConfig();
    const locale = typeof body.locale === "string" && body.locale ? body.locale : config.defaultLocale;
    const modules = asModules(body.modules);
    // 设计约定: 只有勾选了"选人语音"才要求客户端在运行(它必须连 LCU);
    // 对局语音/对局语言只改游戏文件, 客户端没开也能做。恢复原版不受任何限制。
    if (needsClient(modules) && !(await isClientRunning())) {
      return {
        ok: false,
        blocked: true,
        message: "英雄联盟未启动：选人语音需要客户端运行，请先启动客户端并登录到大厅"
      };
    }
    const task = startApplyTask({
      locale,
      modules,
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
    const extension = SUPPORTED_EXTENSIONS.find((ext) => name.toLowerCase().endsWith(ext));
    if (!extension) return { ok: false, error: "bad_request", message: `不支持的格式：${path.basename(name)}（支持 ${SUPPORTED_EXTENSIONS.join(" / ")}）` };
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
    spaFallback: hasWeb,
    maxUploadBytes: config.server.maxUploadBytes,
    uploadDir: path.join(appRoot(), ".tmp", "uploads")
  });
  const unsubscribeTasks = taskManager.subscribe((event: TaskEvent) => router.broadcast(event.type, event));
  const unsubscribeLobby = lobbyLive.subscribe((event) => {
    // 记一条: 推给了几个窗口 —— 排查"后端发了但窗口没播"时最关键的一行
    logger.info(`推送选人事件给 ${router.sseCount} 个窗口: ${event.kind} ${event.championId}`);
    router.broadcast("lobby", event);
  });
  running.server.once("close", () => { unsubscribeTasks(); unsubscribeLobby(); });
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
    last_applied: config.ui?.lastApplied ?? null
  };
}
