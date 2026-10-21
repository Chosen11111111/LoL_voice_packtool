/**
 * 大厅选人语音("对局前选人语音")。
 *
 * 机制: **加载器插件在运行时替换客户端要播的那两句台词** —— 客户端资源包一个字节都不改。
 *
 * 为什么不是直接改资源包: 客户端对 Plugins/rcp-be-lol-game-data/<语种>-assets.wad 有严格的
 * 内容校验(日志: WadFile chunk verification failed), 校验值私有, 40 种常见算法全部不匹配;
 * 连"数据一字不改、只把数据挪到文件尾部"都会让客户端黑屏。
 *
 * 为什么不是以前的"LCU 监听 + 工具窗口播报": 那条路要求工具窗口一直开着、有轮询延迟、
 * 还得靠抑制客户端原声来避免双响。插件路线由客户端自己播, 音画天然同步。
 *
 * 关键: 只部署文件 + 建目录联接, **不需要客户端正在运行**, 也不需要进游戏。
 */
import path from "node:path";
import { isClientRunning } from "../core/win/processes.ts";
import { isDirectory } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";
import { makeResult, type ModuleResult } from "../core/result.ts";
import { localeDisplayName } from "../packs/locales.ts";
import { CHAMPION_BAN, CHAMPION_CHOOSE } from "../packs/championIds.ts";
import { locateClientAssetWad } from "../packs/wadfile.ts";
import { lobbyPatchState, restoreLobbyVoiceWad } from "../packs/lobbyWad.ts";
import {
  cdnLocaleOf,
  countVoiceLines,
  isVoicePluginStaged,
  mountVoiceAssets,
  readVoiceConfig,
  stageVoicePlugin,
  unmountVoiceAssets,
  writeVoiceConfig
} from "../packs/voicePlugin.ts";
import { readRegistry, stageLoader } from "../textpack/deploy.ts";
import type { SwitchEnv } from "./context.ts";

const logger = createLogger("lobby_voice");
const MODULE = "lobby_voice" as const;

export interface LobbyVoiceOptions {
  progress?: import("../core/types.ts").ProgressReporter;
  signal?: AbortSignal;
  /** 兼容旧参数: 插件模式下"别人的禁用台词"由客户端自己决定, 这里不再使用。 */
  includeOthers?: boolean;
}

/** 语音包里该语种的音频根目录(下面有 champion-choose-vo / champion-ban-vo)。 */
export function lobbyAssetsRoot(env: SwitchEnv, locale: string): string {
  return path.join(env.voiceRoot, locale, "assets");
}

/** 旧方案(改写客户端资源包)留下的补丁: 有备份就写回去。 */
async function cleanupLegacyPatch(env: SwitchEnv): Promise<string | null> {
  const located = await locateClientAssetWad(env.leagueDir, env.baseLocale);
  if (!located.ok || !located.path) return null;
  const state = await lobbyPatchState(located.path);
  if (!state.patched) return null;
  if (await isClientRunning()) {
    logger.warn("检测到旧的资源包补丁, 但客户端正在运行 —— 请退出客户端后再还原");
    return "检测到旧的资源包补丁（" + located.path + "），客户端退出后请重新执行还原";
  }
  const result = await restoreLobbyVoiceWad(located.path);
  logger.info("已回滚旧的资源包补丁: " + result.message);
  return "已回滚旧的资源包补丁（" + result.message + "）";
}

/**
 * 开启: 部署插件 + 把语音包的音频联接给插件 + 打开开关。
 * 全程不要求客户端运行; 客户端开着的话, 重启一次才生效。
 */
export async function applyLobbyVoice(
  locale: string,
  env: SwitchEnv,
  options: LobbyVoiceOptions = {}
): Promise<ModuleResult> {
  const progress = options.progress;
  progress?.(0, 4, "检查语音包");

  const assetsRoot = lobbyAssetsRoot(env, locale);
  const available = (await isDirectory(assetsRoot)) ? await countVoiceLines(assetsRoot) : 0;
  if (available === 0) {
    return makeResult(MODULE, false, {
      planned: 0,
      success: 0,
      failed: 0,
      missing: true,
      reason: "资源缺失",
      message: "语音包里没有 " + localeDisplayName(locale) + " 的选人语音：" + assetsRoot
    });
  }

  const notes: string[] = [];
  const legacy = await cleanupLegacyPatch(env);
  if (legacy) notes.push(legacy);

  progress?.(1, 4, "部署插件");
  const loader = await stageLoader();
  if (!loader.ok) {
    return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: "部署失败", message: loader.message });
  }
  if (loader.locked.length) notes.push(loader.locked.join("、"));
  const staged = await stageVoicePlugin();
  if (!staged.ok) {
    return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: "部署失败", message: staged.message });
  }

  progress?.(2, 4, "挂载语音资源");
  const mounted = await mountVoiceAssets(assetsRoot);
  if (!mounted.ok) {
    return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: "挂载失败", message: mounted.message });
  }

  progress?.(3, 4, "写入开关");
  const written = await writeVoiceConfig({ enabled: true, locale, cdn_locale: cdnLocaleOf(locale) });
  if (!written.ok) {
    return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: "写入失败", message: written.message });
  }

  const [registry, clientRunning] = await Promise.all([readRegistry(), isClientRunning()]);
  if (registry !== "set") notes.push("加载器还没激活 —— 需要管理员授权一次（点「开启语音包」会顺带完成）");
  progress?.(4, 4, "完成");

  const message =
    "已开启选人语音（" + localeDisplayName(locale) + "，共 " + available + " 条台词）" +
    (clientRunning ? "，重启客户端后生效" : "，下次启动客户端时生效");

  logger.info("选人语音已开启: locale=" + locale + " lines=" + available + " registry=" + registry);
  return makeResult(MODULE, true, {
    planned: 1,
    success: 1,
    failed: 0,
    message,
    detail: {
      mechanism: "pengu-audio",
      locale,
      available,
      assets_root: assetsRoot,
      loader: loader.dir,
      registry,
      client_running: clientRunning,
      notes
    }
  });
}

/** 关闭: 关掉开关并拆掉联接(插件文件留着, 下次开启不用重新复制)。 */
export async function restoreLobbyVoice(env: SwitchEnv, options: LobbyVoiceOptions = {}): Promise<ModuleResult> {
  const progress = options.progress;
  progress?.(0, 3, "关闭开关");

  const before = await readVoiceConfig();
  const wasEnabled = before?.enabled === true && Boolean(before?.locale) && before?.locale !== "zh_CN";

  const written = await writeVoiceConfig({ enabled: false, locale: "zh_CN", cdn_locale: "zh_cn" });
  progress?.(1, 3, "拆除联接");
  await unmountVoiceAssets();

  progress?.(2, 3, "检查历史补丁");
  const notes: string[] = [];
  const legacy = await cleanupLegacyPatch(env);
  if (legacy) notes.push(legacy);
  progress?.(3, 3, "完成");

  if (!written.ok) {
    return makeResult(MODULE, false, { action: "restore", planned: 1, success: 0, failed: 1, reason: "还原失败", message: written.message });
  }
  return makeResult(MODULE, true, {
    action: "restore",
    planned: 1,
    success: 1,
    failed: 0,
    message: wasEnabled ? "已关闭选人语音" : "选人语音本来就未开启",
    detail: { mechanism: "pengu-audio", stopped: wasEnabled, notes }
  });
}

export interface LobbyStatus {
  ok: boolean;
  voice: string;
  lang: string;
  enabled: boolean;
  locale: string;
  /** 实现机制: 加载器插件在运行时替换音频, 不改客户端资源包。 */
  mechanism: "pengu-audio";
  /** 语音包里该语种的选人/禁用台词条数。 */
  available: number;
  /** 兼容旧字段: 插件模式不轮询, 恒为 false。 */
  listening: boolean;
  presence: string;
  played: number;
  client_running: boolean;
  /** 旧方案(资源包补丁)是否还挂着备份, 需要回滚。 */
  legacy_wad_patch: boolean;
  wad_file: string | null;
  message: string;
}

/** 选人语音当前是否开着(插件就位 + 开关打开 + 不是中文原样)。 */
export async function lobbyVoiceEnabled(): Promise<boolean> {
  const config = await readVoiceConfig();
  if (!config || config.enabled !== true || config.locale === "zh_CN") return false;
  return isVoicePluginStaged();
}

/** 大厅端状态(界面"对局前选人语音"卡片用)。 */
export async function getLobbyStatus(env: SwitchEnv): Promise<LobbyStatus> {
  const config = await readVoiceConfig();
  const staged = await isVoicePluginStaged();
  const enabled = staged && config?.enabled === true && config.locale !== "zh_CN";
  const locale = enabled ? config!.locale : env.config.defaultLocale;
  const available = await countVoiceLines(lobbyAssetsRoot(env, locale));
  const [clientRunning, located] = await Promise.all([
    isClientRunning(),
    locateClientAssetWad(env.leagueDir, env.baseLocale)
  ]);
  const legacy = located.path ? (await lobbyPatchState(located.path)).patched : false;

  const parts: string[] = [];
  if (enabled) {
    parts.push("已开启（" + localeDisplayName(config!.locale) + "）");
    parts.push("共 " + available + " 条台词");
  } else {
    parts.push("未开启");
  }
  if (legacy) parts.push("检测到旧资源包补丁, 还原即可回滚");

  return {
    ok: true,
    voice: enabled ? "已开启（" + localeDisplayName(config!.locale) + "）" : "未开启",
    lang: "未知",
    enabled,
    locale,
    mechanism: "pengu-audio",
    available,
    listening: false,
    presence: clientRunning ? "out" : "offline",
    played: 0,
    client_running: clientRunning,
    legacy_wad_patch: legacy,
    wad_file: located.path,
    message: parts.join(" · ")
  };
}

export { CHAMPION_BAN, CHAMPION_CHOOSE };
