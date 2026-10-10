/**
 * 大厅选人语音(客户端自带资源包 WAD 方案, 不注入任何进程)。
 *
 * 实测结论:
 *   - 选人/禁用台词存放在 LeagueClient\\Plugins\\rcp-be-lol-game-data\\<客户端语种>-assets.wad;
 *   - 国服 zh_CN-assets.wad 里有 351 个 ogg(≈173 选人 + 173 禁用);
 *   - 国际服 zh_TW-assets.wad 里只有 5 个 ogg(该渠道的选人语音不在语种包里)。
 *
 * 补丁方式: 备份原 wad → 把本地语音包的音频按 16 字节对齐追加到文件尾部 →
 * 只改动对应条目的偏移与大小(签名块、条目顺序、条目数都不动) → 原子改名落地。
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { makeResult, type ModuleResult } from "../core/result.ts";
import { isClientRunning } from "../core/win/processes.ts";
import { isFile, walkFiles } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";
import { localeDisplayName } from "../packs/locales.ts";
import { CHAMPION_BAN, CHAMPION_CHOOSE, extractIds } from "../packs/championIds.ts";
import { locateClientAssetWad } from "../packs/wadfile.ts";
import {
  applyLobbyVoiceWad,
  lobbyPatchState,
  restoreLobbyVoiceWad
} from "../packs/lobbyWad.ts";
import type { SwitchEnv } from "./context.ts";

const logger = createLogger("lobby_voice");
const MODULE = "lobby_voice" as const;

export interface LobbyVoiceOptions {
  progress?: import("../core/types.ts").ProgressReporter;
  signal?: AbortSignal;
}

/** 扫描本地语音包里可用的英雄 ID。 */
async function localChampionIds(voiceRoot: string, locale: string, type: string): Promise<number[]> {
  const dir = path.join(voiceRoot, locale, "assets", type);
  const files = await walkFiles(dir, { match: (name) => name.toLowerCase().endsWith(".ogg") });
  const ids = new Set<number>();
  for (const file of files) {
    const id = Number.parseInt(path.basename(file, path.extname(file)), 10);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

function clientRunningMessage(): string {
  return "英雄联盟客户端正在运行，资源包被占用无法替换。请先完全退出客户端（含右下角托盘图标），再切换大厅语音。";
}

/** 开启大厅选人语音: 把目标语种的选人/禁用台词写入客户端资源包。 */
export async function applyLobbyVoice(locale: string, env: SwitchEnv, options: LobbyVoiceOptions = {}): Promise<ModuleResult> {
  const progress = options.progress;
  progress?.(0, 1, "定位客户端资源包");

  const located = await locateClientAssetWad(env.leagueDir, env.baseLocale);
  if (!located.ok || !located.path) {
    return makeResult(MODULE, false, {
      planned: 0,
      success: 0,
      failed: 0,
      missing: true,
      reason: "资源缺失",
      message: located.message
    });
  }
  if (await isClientRunning()) {
    return makeResult(MODULE, false, {
      planned: 0,
      success: 0,
      failed: 0,
      reason: "客户端运行中",
      message: clientRunningMessage()
    });
  }

  const chooseIds = await localChampionIds(env.voiceRoot, locale, CHAMPION_CHOOSE);
  const banIds = await localChampionIds(env.voiceRoot, locale, CHAMPION_BAN);
  const ids = [...new Set([...chooseIds, ...banIds])];
  if (!ids.length) {
    return makeResult(MODULE, false, {
      planned: 0,
      success: 0,
      failed: 0,
      missing: true,
      reason: "资源缺失",
      message:
        `本地语音包里没有选人/禁用台词：` +
        `${path.join(env.voiceRoot, locale, "assets", CHAMPION_CHOOSE)} 与 .../${CHAMPION_BAN}`
    });
  }

  logger.info(`开始写入大厅选人语音: ${locale} -> ${located.path}（${ids.length} 个英雄）`);
  const result = await applyLobbyVoiceWad({
    wadFile: located.path,
    voiceRoot: env.voiceRoot,
    locale,
    appDir: env.appDir,
    cdnBase: env.config.cdnBase,
    clientLocale: env.baseLocale,
    ids,
    signal: options.signal,
    onLog: (line) => logger.info(line),
    onProgress: (done, total, current) => {
      // 识别阶段占前 80%, 写入阶段收尾
      progress?.(Math.min(done, total), Math.max(total, 1) * 1, current);
      progress?.(Math.round((done / Math.max(total, 1)) * 80), 100, current);
    }
  });
  progress?.(100, 100, "完成");

  return makeResult(MODULE, result.ok, {
    planned: result.mapping.choose + result.mapping.ban,
    success: result.patched,
    failed: result.ok ? 0 : 1,
    missing: result.missing > 0,
    message: result.message,
    detail: {
      locale,
      wad_file: result.wad_file,
      backup: result.backup,
      mapping: result.mapping,
      notes: result.detail
    }
  });
}

/** 还原: 写回客户端原始资源包。 */
export async function restoreLobbyVoice(env: SwitchEnv, options: LobbyVoiceOptions = {}): Promise<ModuleResult> {
  options.progress?.(0, 1, "检查备份");
  const located = await locateClientAssetWad(env.leagueDir, env.baseLocale);
  if (!located.ok || !located.path) {
    return makeResult(MODULE, true, {
      action: "restore",
      planned: 0,
      success: 0,
      failed: 0,
      message: located.message
    });
  }
  if (await isClientRunning()) {
    return makeResult(MODULE, false, {
      action: "restore",
      planned: 0,
      success: 0,
      failed: 0,
      reason: "客户端运行中",
      message: clientRunningMessage()
    });
  }
  const result = await restoreLobbyVoiceWad(located.path);
  options.progress?.(1, 1, "完成");
  return makeResult(MODULE, result.ok, {
    action: "restore",
    planned: result.ok ? 1 : 0,
    success: result.ok ? 1 : 0,
    failed: result.ok ? 0 : 1,
    message: result.message,
    detail: { wad_file: result.wad_file }
  });
}

export interface LobbyStatus {
  ok: boolean;
  voice: string;
  lang: string;
  enabled: boolean;
  locale: string;
  /** 实现机制: 客户端自带资源包, 不注入进程。 */
  mechanism: "wad";
  wad_file: string | null;
  wad_available: boolean;
  patched: boolean;
  backup: string | null;
  message: string;
}

/** 大厅端状态: 定位资源包 + 判断是否已打补丁。 */
export async function getLobbyStatus(env: SwitchEnv): Promise<LobbyStatus> {
  const located = await locateClientAssetWad(env.leagueDir, env.baseLocale);
  const state = await lobbyPatchState(located.path);
  const total = located.path ? await fsp.stat(located.path).then((info) => info.size).catch(() => 0) : 0;
  return {
    ok: true,
    voice: state.patched ? "已替换为自定义选人语音" : "官方默认",
    lang: "未知",
    enabled: state.patched,
    locale: env.baseLocale,
    mechanism: "wad",
    wad_file: located.path,
    wad_available: located.ok,
    patched: state.patched,
    backup: state.backup,
    message: located.ok
      ? `${located.path}${total ? `（${(total / 1048576).toFixed(1)} MB）` : ""}${state.patched ? " — 已打补丁" : ""}`
      : located.message
  };
}

export { extractIds, localeDisplayName, isFile };
