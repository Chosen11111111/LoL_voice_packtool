/**
 * 大厅选人语音("对局前选人语音")。
 *
 * 机制: **LCU 监听 + 本地播报** —— 客户端一个字节都不改。
 *
 * 为什么不是改客户端资源包: 客户端对 Plugins/rcp-be-lol-game-data/<语种>-assets.wad
 * 有严格的内容校验(日志: WadFile chunk verification failed), 校验值是私有的, 实测
 * 40 种常见算法全部不匹配; 连"数据一字不改、只把数据挪到文件尾部"都会让客户端黑屏。
 * 因此选人台词改成: 用 LCU 监听选人流程 -> 在工具窗口里播语音包里的音频。
 *
 * 兼容: 如果之前用旧方案(改写资源包)打过补丁, 这里会在开启/还原时自动把备份写回去。
 */
import path from "node:path";
import { makeResult, type ModuleResult } from "../core/result.ts";
import { isClientRunning } from "../core/win/processes.ts";
import { isDirectory } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";
import { localeDisplayName } from "../packs/locales.ts";
import { CHAMPION_BAN, CHAMPION_CHOOSE } from "../packs/championIds.ts";
import { locateClientAssetWad } from "../packs/wadfile.ts";
import { lobbyPatchState, restoreLobbyVoiceWad } from "../packs/lobbyWad.ts";
import { lobbyLive } from "./lobbyLive.ts";
import type { SwitchEnv } from "./context.ts";

const logger = createLogger("lobby_voice");
const MODULE = "lobby_voice" as const;

export interface LobbyVoiceOptions {
  progress?: import("../core/types.ts").ProgressReporter;
  signal?: AbortSignal;
  /** 是否连别人的禁用台词一起播。 */
  includeOthers?: boolean;
}

/** 本地语音包里该语种的音频目录。 */
function assetsDir(env: SwitchEnv, locale: string, type: string): string {
  return path.join(env.voiceRoot, locale, "assets", type);
}

async function hasLocalAudio(env: SwitchEnv, locale: string): Promise<boolean> {
  return isDirectory(assetsDir(env, locale, CHAMPION_CHOOSE));
}

/** 旧方案(改写客户端资源包)留下的补丁: 有备份就写回去。 */
async function cleanupLegacyPatch(env: SwitchEnv): Promise<string | null> {
  const located = await locateClientAssetWad(env.leagueDir, env.baseLocale);
  if (!located.ok || !located.path) return null;
  const state = await lobbyPatchState(located.path);
  if (!state.patched) return null;
  if (await isClientRunning()) {
    logger.warn("检测到旧的资源包补丁, 但客户端正在运行 —— 请退出客户端后再还原");
    return `检测到旧的资源包补丁(${located.path}), 客户端退出后请重新执行还原`;
  }
  const result = await restoreLobbyVoiceWad(located.path);
  logger.info(`已回滚旧的资源包补丁: ${result.message}`);
  return `已回滚旧的资源包补丁(${result.message})`;
}

/** 开启: 启动 LCU 监听, 之后选人时由工具窗口播报语音包里的台词。 */
export async function applyLobbyVoice(locale: string, env: SwitchEnv, options: LobbyVoiceOptions = {}): Promise<ModuleResult> {
  const progress = options.progress;
  progress?.(0, 2, "检查语音包");

  if (!(await hasLocalAudio(env, locale))) {
    return makeResult(MODULE, false, {
      planned: 0,
      success: 0,
      failed: 0,
      missing: true,
      reason: "资源缺失",
      message: `语音包里没有 ${localeDisplayName(locale)} 的选人语音：${assetsDir(env, locale, CHAMPION_CHOOSE)}`
    });
  }

  const notes: string[] = [];
  const legacy = await cleanupLegacyPatch(env);
  if (legacy) notes.push(legacy);

  progress?.(1, 2, "启动监听");
  const started = await lobbyLive.start({
    voiceRoot: env.voiceRoot,
    locale,
    includeOthers: options.includeOthers
  });
  if (!started.ok) {
    return makeResult(MODULE, false, {
      planned: 1,
      success: 0,
      failed: 1,
      reason: "启动失败",
      message: started.message,
      detail: { notes }
    });
  }

  const clientRunning = await isClientRunning();
  if (!clientRunning) notes.push("客户端当前没有运行 —— 启动客户端后会自动开始监听, 无需再次操作");
  progress?.(2, 2, "完成");

  return makeResult(MODULE, true, {
    planned: 1,
    success: 1,
    failed: 0,
    message: `已开启选人语音实时播报（${localeDisplayName(locale)}）${clientRunning ? "" : "，等待客户端启动"}`,
    detail: {
      mechanism: "lcu-live",
      locale,
      available: started.state.available,
      client_running: clientRunning,
      notes
    }
  });
}

/** 关闭: 停止监听; 若存在旧的资源包补丁, 一并回滚。 */
export async function restoreLobbyVoice(env: SwitchEnv, options: LobbyVoiceOptions = {}): Promise<ModuleResult> {
  const progress = options.progress;
  progress?.(0, 2, "停止监听");
  const wasRunning = lobbyLive.isRunning();
  await lobbyLive.stop();
  progress?.(1, 2, "检查历史补丁");
  const notes: string[] = [];
  const legacy = await cleanupLegacyPatch(env);
  if (legacy) notes.push(legacy);
  progress?.(2, 2, "完成");
  return makeResult(MODULE, true, {
    action: "restore",
    planned: 1,
    success: 1,
    failed: 0,
    message: wasRunning ? "已关闭选人语音实时播报" : "选人语音实时播报本来就未开启",
    detail: { mechanism: "lcu-live", stopped: wasRunning, notes }
  });
}

export interface LobbyStatus {
  ok: boolean;
  voice: string;
  lang: string;
  enabled: boolean;
  locale: string;
  /** 实现机制: LCU 监听 + 本地播报, 不注入、不改客户端文件。 */
  mechanism: "lcu-live";
  /** 本地语音包里该语种的选人/禁用音频数量。 */
  available: number;
  /** 是否正在监听选人流程。 */
  listening: boolean;
  /** 选人流程状态: in(正在选人) / out(不在选人) / offline(客户端没起来)。 */
  presence: string;
  played: number;
  client_running: boolean;
  /** 旧方案(资源包补丁)是否还挂着备份, 需要回滚。 */
  legacy_wad_patch: boolean;
  wad_file: string | null;
  message: string;
}

/** 大厅端状态(界面顶部"对局前选人语音"卡片用)。 */
export async function getLobbyStatus(env: SwitchEnv): Promise<LobbyStatus> {
  const state = lobbyLive.state();
  const [clientRunning, located] = await Promise.all([
    isClientRunning(),
    locateClientAssetWad(env.leagueDir, env.baseLocale)
  ]);
  const legacy = located.path ? (await lobbyPatchState(located.path)).patched : false;
  const locale = state.locale || env.config.defaultLocale;
  const parts: string[] = [];
  if (state.running) {
    parts.push(`监听中（${localeDisplayName(locale)}）`);
    parts.push(state.presence === "in" ? "选人进行中" : state.presence === "out" ? "等待进入选人" : "客户端未启动");
    parts.push(`已播报 ${state.played} 条`);
  } else {
    parts.push("未开启");
  }
  if (legacy) parts.push("检测到旧资源包补丁, 还原即可回滚");
  return {
    ok: true,
    voice: state.running ? `已开启实时播报（${localeDisplayName(locale)}）` : "未开启",
    lang: "未知",
    enabled: state.running,
    locale,
    mechanism: "lcu-live",
    available: state.available,
    listening: state.running,
    presence: state.presence,
    played: state.played,
    client_running: clientRunning,
    legacy_wad_patch: legacy,
    wad_file: located.path,
    message: parts.join(" · ")
  };
}

export { CHAMPION_BAN, CHAMPION_CHOOSE };
