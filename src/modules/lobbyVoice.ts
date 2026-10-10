/**
 * 大厅选人语音(客户端 WAD 机制)。
 *
 * 机制说明: 选人/禁用台词由客户端自身提供 ——
 *   LeagueClient\\Plugins\\rcp-be-lol-game-data\\<客户端语种>-assets.wad
 * 目标是直接修改/替换该 wad 里对应条目的音频数据, **不向客户端注入任何代码**。
 *
 * 当前状态: WAD 解析已打通(src/packs/wadfile.ts), 补丁写入与"客户端是否校验签名"
 * 的现场验证尚未完成, 因此这里先返回明确的未就绪结果, 不做任何文件改动。
 */
import { makeResult, type ModuleResult } from "../core/result.ts";
import type { SwitchEnv } from "./context.ts";

const MODULE = "lobby_voice" as const;
const NOT_READY =
  "大厅选人语音的 WAD 方案尚未接入完成（当前不会修改任何文件）。\n" +
  "已确认客户端资源位置：LeagueClient\\Plugins\\rcp-be-lol-game-data\\<语种>-assets.wad";

export interface LobbyVoiceOptions {
  progress?: import("../core/types.ts").ProgressReporter;
  signal?: AbortSignal;
}

/** 开启大厅选人语音(WAD 方案, 未完成)。 */
export async function applyLobbyVoice(locale: string, env: SwitchEnv, options: LobbyVoiceOptions = {}): Promise<ModuleResult> {
  options.progress?.(0, 1);
  return makeResult(MODULE, false, {
    planned: 0,
    success: 0,
    failed: 0,
    missing: true,
    reason: "能力未接入",
    message: NOT_READY
  });
}

/** 还原大厅选人语音(WAD 方案, 未完成)。 */
export async function restoreLobbyVoice(env: SwitchEnv, options: LobbyVoiceOptions = {}): Promise<ModuleResult> {
  options.progress?.(0, 1);
  return makeResult(MODULE, true, {
    action: "restore",
    planned: 0,
    success: 0,
    failed: 0,
    message: "大厅选人语音无需还原（WAD 方案未启用）"
  });
}

export interface LobbyStatus {
  ok: boolean;
  voice: string;
  lang: string;
  enabled: boolean;
  locale: string;
  /** 实现机制: 客户端自带资源 wad, 不注入进程。 */
  mechanism: "wad";
  wad_file: string | null;
  wad_available: boolean;
  patched: boolean;
  message: string;
}

/** 大厅端状态: 定位客户端资源 wad, 判断是否可打补丁。 */
export async function getLobbyStatus(env: SwitchEnv): Promise<LobbyStatus> {
  const { locateClientAssetWad } = await import("../packs/wadfile.ts");
  const located = await locateClientAssetWad(env.resolution.leagueDir || null, env.baseLocale);
  return {
    ok: true,
    voice: "官方默认",
    lang: "未知",
    enabled: false,
    locale: env.baseLocale,
    mechanism: "wad",
    wad_file: located.path,
    wad_available: located.ok,
    patched: false,
    message: located.ok ? `资源包：${located.path}` : located.message
  };
}
