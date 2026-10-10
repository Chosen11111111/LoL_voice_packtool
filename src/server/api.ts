/** REST API: 界面(未来任意前端)只需对着这一组接口写。 */
import path from "node:path";
import { APP_NAME, APP_NAME_CN, APP_VERSION, API_VERSION } from "../version.ts";
import { loadConfig, appRoot, type AppConfig } from "../core/config.ts";
import { isDirectory } from "../core/fsx.ts";
import type { ModuleId } from "../core/types.ts";
import { invalidateConfigCache } from "../core/config.ts";
import { setLogLevel, type LogLevel } from "../core/logger.ts";
import { Router, startHttpServer, type RunningServer } from "./http.ts";
import { taskManager, type TaskEvent } from "../tasks/manager.ts";
import {
  buildEnvFromConfig,
  doctor,
  getDashboard,
  getLocales,
  inspectPaths,
  installPlugin,
  planSwitch,
  startApplyTask,
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

  router.get("/api/state", async () => ({ ok: true, state: await getDashboard() }));

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

  router.post("/api/update/check", () => ({ ok: true, task: startUpdateCheckTask() }));

  router.post("/api/update/run", (context) => {
    const body = asRecord(context.body);
    const locales = Array.isArray(body.locales) ? body.locales.filter((item): item is string => typeof item === "string") : undefined;
    return { ok: true, task: startUpdateRunTask({ locales }) };
  });

  router.post("/api/plugin/install", async (context) => {
    const body = asRecord(context.body);
    const plugin = await installPlugin(Boolean(body.force));
    return { ok: plugin.ok, message: plugin.message, plugin_dir: plugin.pluginDir };
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
  return { dashboard: await getDashboard(), env: { voiceRoot: env.voiceRoot, penguDir: env.penguDir } };
}
