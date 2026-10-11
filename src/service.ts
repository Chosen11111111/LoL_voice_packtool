/**
 * 服务层: HTTP API 与 CLI 共用同一套业务入口, 保证两条路径行为完全一致。
 */
import path from "node:path";
import { APP_NAME_CN, APP_VERSION } from "./version.ts";
import { appRoot, configPath, loadConfig, saveConfig, type AppConfig, type ConfigPatch } from "./core/config.ts";
import { removeQuietly } from "./core/fsx.ts";
import { createLogger } from "./core/logger.ts";
import type { ModuleId } from "./core/types.ts";
import { detectCandidates, resolveGamePaths } from "./core/paths.ts";
import { isClientRunning, isGameRunning } from "./core/win/processes.ts";
import { checkModuleResources, estimateSpaceRequirement, getIngameStatus, type IngameStatus, type ResourceCheck, type SpaceEstimate } from "./packs/inventory.ts";
import { wadSuffix } from "./packs/baselocale.ts";
import { scanLocales } from "./packs/locales.ts";
import { importArchive } from "./packs/archive.ts";
import { checkRemoteVersion, inventorySnapshot, syncLocale, writeVersionFile } from "./packs/updater.ts";
import { applyAll, restoreAll } from "./modules/oneclick.ts";
import { getLobbyStatus, type LobbyStatus } from "./modules/lobbyVoice.ts";
import { lobbyLive } from "./modules/lobbyLive.ts";
import { buildEnv, type SwitchEnv } from "./modules/context.ts";
import { taskManager, type TaskSnapshot } from "./tasks/manager.ts";

const logger = createLogger("service");

export interface PathsPayload {
  finalDir: string | null;
  gameDir: string | null;
  leagueDir: string;
  source: string;
  sourceDetail: string;
  mismatch: boolean;
  message: string;
}

export function pathsPayload(env: SwitchEnv): PathsPayload {
  return {
    finalDir: env.resolution.finalDir,
    gameDir: env.resolution.gameDir,
    leagueDir: env.resolution.leagueDir,
    source: env.resolution.source,
    sourceDetail: env.resolution.sourceDetail,
    mismatch: env.resolution.mismatch,
    message: env.resolution.message
  };
}

/** 客户端语种与渠道(界面用来显示"国服/外服"与目标槽位)。 */
export function clientInfoPayload(env: SwitchEnv) {
  return {
    region: env.region,
    region_label: env.region === "cn" ? "国服" : "外服",
    base_locale: env.baseLocale,
    base_locale_source: env.baseLocaleSource,
    base_locale_detail: env.baseLocaleDetail,
    target_suffix: wadSuffix(env.baseLocale)
  };
}

export interface DashboardState {
  app: { name: string; version: string; appRoot: string; configPath: string };
  paths: PathsPayload;
  voiceRoot: string;
  voiceRootSource: string;
  ingame: IngameStatus;
  lobby: LobbyStatus;
  processes: { game_running: boolean; client_running: boolean };
  tasks: TaskSnapshot[];
  busy: Record<string, string>;
}

export async function buildEnvFromConfig(config: AppConfig, options: { skipProcess?: boolean } = {}): Promise<SwitchEnv> {
  return buildEnv({ config, appDir: appRoot(), skipProcess: options.skipProcess });
}

/** 首页状态: 一次返回界面需要的全部只读信息。 */
export async function getDashboard(): Promise<DashboardState> {
  const config = await loadConfig();
  const env = await buildEnvFromConfig(config);
  const [ingame, lobby, gameRunning, clientRunning] = await Promise.all([
    getIngameStatus({
      finalDir: env.finalDir,
      voiceRoot: env.voiceRoot,
      locale: config.defaultLocale,
      message: env.resolution.message,
      source: env.resolution.source
    }),
    getLobbyStatus(env),
    isGameRunning(),
    isClientRunning()
  ]);
  return {
    app: { name: APP_NAME_CN, version: APP_VERSION, appRoot: env.appDir, configPath: configPath() },
    paths: pathsPayload(env),
    voiceRoot: env.voiceRoot,
    voiceRootSource: env.voiceRootSource,
    ingame,
    lobby,
    processes: { game_running: gameRunning, client_running: clientRunning },
    tasks: taskManager.list(),
    busy: taskManager.busyGroups()
  };
}

export interface LocalePayload {
  code: string;
  name: string;
  has_voice: boolean;
  has_lang: boolean;
  has_lobby: boolean;
  has_maps: boolean;
  voice_files: number;
  map_files: number;
  lang_files: number;
  lobby_files: number;
  active: boolean;
  current: { voice: boolean; lang: boolean; lobby: boolean };
}

/** 可用语言包列表(附带当前生效状态)。 */
export async function getLocales(options: { withCounts?: boolean } = {}): Promise<{ root: string; active_locale: string; locales: LocalePayload[] }> {
  const config = await loadConfig();
  const env = await buildEnvFromConfig(config);
  const rows = await scanLocales(env.voiceRoot, { withCounts: options.withCounts ?? true });
  const ingame = await getIngameStatus({ finalDir: env.finalDir, voiceRoot: env.voiceRoot, locale: config.defaultLocale });
  const lobby = await getLobbyStatus(env);
  return {
    root: env.voiceRoot,
    active_locale: ingame.active_locale,
    locales: rows.map((row) => ({
      ...row,
      active: row.code === ingame.active_locale,
      current: {
        voice: row.code === ingame.active_locale && ingame.is_voice_active,
        lang: row.code === ingame.active_locale && ingame.is_lang_active,
        lobby: row.code === lobby.locale && lobby.enabled
      }
    }))
  };
}

export interface SwitchPlan {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  checks: ResourceCheck[];
  space: SpaceEstimate;
  ingame: IngameStatus;
  lobby: LobbyStatus;
  paths: PathsPayload;
  voiceRoot: string;
}

/** 切换前的干跑: 只读校验, 不改任何东西(界面"开始切换"按钮前的预检)。 */
export async function planSwitch(options: { locale: string; modules?: ModuleId[] }): Promise<SwitchPlan> {
  const config = await loadConfig();
  const env = await buildEnvFromConfig(config);
  const modules: ModuleId[] = options.modules?.length ? options.modules : defaultApplyModules(config);
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!env.resolution.ok) blockers.push(env.resolution.message);
  if (await isGameRunning()) blockers.push("检测到游戏对局正在进行中，请退出对局后再切换。");
  if (!env.resolution.leagueDir && modules.includes("lobby_lang")) {
    blockers.push("未定位到联盟客户端目录，无法修改大厅界面语言。");
  }

  const checks = await Promise.all(
    modules.map((module) => checkModuleResources(module, options.locale, { voiceRoot: env.voiceRoot }))
  );
  for (const check of checks) {
    if (!check.ok) blockers.push(`${check.module_name}：${check.message}`);
  }

  const space = await estimateSpaceRequirement({
    modules: modules.filter((module) => module === "ingame_voice" || module === "ingame_lang"),
    locale: options.locale,
    voiceRoot: env.voiceRoot,
    finalDir: env.finalDir,
    baseSuffix: wadSuffix(env.baseLocale)
  });
  if (!space.ok) blockers.push(space.message);
  else if (space.message) warnings.push(space.message);

  const [ingame, lobby] = await Promise.all([
    getIngameStatus({ finalDir: env.finalDir, voiceRoot: env.voiceRoot, locale: options.locale, message: env.resolution.message, source: env.resolution.source }),
    getLobbyStatus(env)
  ]);

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    checks,
    space,
    ingame,
    lobby,
    paths: pathsPayload(env),
    voiceRoot: env.voiceRoot
  };
}

/* ---------------------------------------------------------------- 默认模块 */

/**
 * 默认切换范围 = 对局语音 + 对局文本。
 * 大厅相关能力(大厅选人语音 / 大厅界面语言)由 features 开关控制: 关闭时不出现在默认流程里,
 * 但接口仍可显式指定 modules 调用(后端能力保留)。
 */
export function defaultApplyModules(config: AppConfig): ModuleId[] {
  const modules: ModuleId[] = [];
  if (config.features.lobbyVoice) modules.push("lobby_voice");
  modules.push("ingame_voice", "ingame_lang");
  return modules;
}

/** 默认还原范围: 大厅能力关闭时, 只在大厅确实处于开启状态才把它加回来(避免残留)。 */
async function defaultRestoreModules(config: AppConfig, env: SwitchEnv): Promise<ModuleId[]> {
  const modules: ModuleId[] = [];
  // 选人语音现在是"LCU 监听 + 本地播报": 只要监听还在跑就必须带上, 否则一键还原关不掉它
  if (config.features.lobbyVoice || lobbyLive.isRunning()) modules.push("lobby_voice");
  if (config.features.lobbyLang) modules.push("lobby_lang");
  modules.push("ingame_voice", "ingame_lang");
  return modules;
}

/* ---------------------------------------------------------------- 任务入口 */

export interface ApplyRequest {
  locale: string;
  modules?: ModuleId[];
  restartClient?: boolean;
  lobbyLang?: "keep" | "en_US" | "zh_CN";
  oneClick?: boolean;
}

export function startApplyTask(request: ApplyRequest): TaskSnapshot {
  return taskManager.startSnapshot("oneclick_apply", `切换语音包 → ${request.locale}`, async (handle) => {
    const appConfig = await loadConfig();
    const env = await buildEnvFromConfig(appConfig);
    if (!env.resolution.ok) {
      return { ok: false, partial: false, restarted: false, message: env.resolution.message, summary: { ok: false, partial: false, lines: [], failed: [] }, results: [] };
    }
    const locale = request.locale || appConfig.defaultLocale;
    const modules: ModuleId[] = request.modules?.length ? request.modules : defaultApplyModules(appConfig);
    const result = await applyAll(env, {
      locale, modules,
      restartClient: request.restartClient ?? appConfig.autoRestartClient,
      progress: handle.progress, signal: handle.signal, lobbyLang: request.lobbyLang
    });
    // 记住"上次开启": 重启工具后界面要能如实说明现在生效的是什么(否则会显示"国服原版"让人误以为没生效)
    if (result.ok) {
      try {
        await saveConfig({ ui: { lastApplied: { locale, modules: [...modules], at: new Date().toISOString() } } });
      } catch (error) {
        logger.warn(`记录上次开启失败: ${String((error as Error).message ?? error)}`);
      }
    }
    return result;
  });
}

export interface RestoreRequest {
  modules?: ModuleId[];
  restartClient?: boolean;
  oneClick?: boolean;
}

export function startRestoreTask(request: RestoreRequest = {}): TaskSnapshot {
  return taskManager.startSnapshot("oneclick_restore", "恢复官方默认", async (handle) => {
    const appConfig = await loadConfig();
    const env = await buildEnvFromConfig(appConfig);
    const modules: ModuleId[] = request.modules?.length ? request.modules : await defaultRestoreModules(appConfig, env);

    const result = await restoreAll(env, {
      modules, restartClient: request.restartClient ?? appConfig.autoRestartClient,
      progress: handle.progress, signal: handle.signal
    });
    // 还原成功就把"上次开启"记录清掉(否则界面会显示一个已经失效的状态)
    if (result.ok) {
      try {
        await saveConfig({ ui: { lastApplied: null } });
      } catch (error) {
        logger.warn(`清除上次开启记录失败: ${String((error as Error).message ?? error)}`);
      }
    }
    return result;
  });
}

export interface ImportRequest {
  /** 压缩包路径(上传落盘的临时文件, 或用户直接给的本地路径)。 */
  archive: string;
  archiveName?: string;
  locale?: string;
  overwrite?: boolean;
  /** 导入结束后删除压缩包(上传的临时文件用)。 */
  deleteAfter?: boolean;
}

/** 导入语音包压缩包: 解压 -> 识别语种 -> 装进资源目录(完成后自动出现在语音包列表)。 */
export function startImportTask(request: ImportRequest): TaskSnapshot {
  return taskManager.startSnapshot("pack_import", `导入语音包 ${path.basename(request.archiveName ?? request.archive)}`, async (handle) => {
    try {
      const config = await loadConfig();
      const env = await buildEnvFromConfig(config, { skipProcess: true });
      const result = await importArchive({
        archive: request.archive,
        archiveName: request.archiveName,
        locale: request.locale,
        voiceRoot: env.voiceRoot,
        overwrite: request.overwrite,
        signal: handle.signal,
        onLog: (line) => handle.log(line),
        onProgress: (phase, percent) => handle.progress(Math.round(percent), 100, phase)
      });
      handle.progress(100, 100, "完成");
      if (!result.ok) throw new Error(result.message);
      const locales = await scanLocales(env.voiceRoot, { withCounts: true });
      return { ...result, locales, voiceRoot: env.voiceRoot };
    } finally {
      if (request.deleteAfter) await removeQuietly(request.archive);
    }
  });
}

export function startUpdateCheckTask(): TaskSnapshot {
  return taskManager.startSnapshot("update_check", "检查语音包更新", async (handle) => {
    const config = await loadConfig();
    const env = await buildEnvFromConfig(config, { skipProcess: true });
    handle.log("正在连接 CommunityDragon 检查版本…");
    const info = await checkRemoteVersion(config, env.voiceRoot, handle.signal);
    const inventory = await inventorySnapshot(env.voiceRoot, config.supportedLocales);
    handle.log(info.detail);
    return { info, inventory, voiceRoot: env.voiceRoot };
  });
}

export interface UpdateRunRequest {
  locales?: string[];
}

export function startUpdateRunTask(request: UpdateRunRequest = {}): TaskSnapshot {
  const targets = request.locales?.length ? request.locales : null;
  return taskManager.startSnapshot("update_run", "增量同步语音包", async (handle) => {
    const config = await loadConfig();
    const env = await buildEnvFromConfig(config, { skipProcess: true });
    const locales = [...new Set(targets ?? config.supportedLocales)];
    const results = [];
    let done = 0;
    const total = locales.length;
    for (const code of locales) {
      if (handle.isCancelled()) break;
      handle.log(`开始同步 ${code} …`);
      const result = await syncLocale(code, config, env.voiceRoot, {
        signal: handle.signal,
        onProgress: (_inner, _innerTotal, current) => handle.progress(done, total, current),
        onLine: (line) => handle.log(line)
      });
      results.push(result);
      done += 1;
      handle.progress(done, total, code);
      handle.log(result.message);
    }
    handle.signal.throwIfAborted();
    const remote = await checkRemoteVersion(config, env.voiceRoot, handle.signal);
    const ok = results.length === locales.length && results.every((item) => item.ok);
    if (ok && !remote.offline && config.supportedLocales.every((code) => locales.includes(code))) {
      await writeVersionFile(env.voiceRoot, config, remote.remoteVersion);
    }
    const inventory = await inventorySnapshot(env.voiceRoot, config.supportedLocales);
    return { ok, message: ok ? "语音包同步完成" : "部分资源同步失败，请查看结果后重试", results, inventory, remote };
  });
}

/** 路径自动侦测(诊断/首次配置)。 */
export async function inspectPaths(): Promise<{ resolution: PathsPayload; candidates: Awaited<ReturnType<typeof detectCandidates>> }> {
  const config = await loadConfig();
  const resolution = await resolveGamePaths({ leaguePath: config.leaguePath, gamePath: config.gamePath });
  const candidates = await detectCandidates();
  return {
    resolution: {
      finalDir: resolution.finalDir,
      gameDir: resolution.gameDir,
      leagueDir: resolution.leagueDir,
      source: resolution.source,
      sourceDetail: resolution.sourceDetail,
      mismatch: resolution.mismatch,
      message: resolution.message
    },
    candidates
  };
}

/** 环境自检(doctor)。 */
export async function doctor(): Promise<Record<string, unknown>> {
  const config = await loadConfig();
  const env = await buildEnvFromConfig(config);
  const [lobby, gameRunning, clientRunning] = await Promise.all([
    getLobbyStatus(env),
    isGameRunning(),
    isClientRunning()
  ]);
  const locales = await scanLocales(env.voiceRoot, { withCounts: false });
  return {
    app: { version: APP_VERSION, appRoot: env.appDir, node: process.version, platform: process.platform },
    config: { path: path.join(env.appDir, "config.json"), voiceRoot: env.voiceRoot, voiceRootSource: env.voiceRootSource, baseLocale: env.baseLocale, region: env.region },
    paths: pathsPayload(env),
    processes: { game_running: gameRunning, client_running: clientRunning },
    lobby: {
      mechanism: lobby.mechanism,
      enabled: lobby.enabled,
      listening: lobby.listening,
      presence: lobby.presence,
      played: lobby.played,
      available: lobby.available,
      client_running: lobby.client_running,
      legacy_wad_patch: lobby.legacy_wad_patch
    },
    locales: locales.map((item) => ({ code: item.code, voice: item.has_voice, lang: item.has_lang, lobby: item.has_lobby }))
  };
}

export async function updateConfig(patch: ConfigPatch): Promise<AppConfig> {
  const next = await saveConfig(patch);
  logger.info(`配置已更新: ${Object.keys(patch).join(", ")}`);
  return next;
}
