/** 一键操作: 按勾选模块顺序执行, 进度按工作量折算成一条总进度。 */
import { createLogger } from "../core/logger.ts";
import { summarize, type ModuleResult, type ResultSummary } from "../core/result.ts";
import type { ModuleId, ProgressReporter } from "../core/types.ts";
import { isClientRunning, isGameRunning } from "../core/win/processes.ts";
import { restartClientUx, waitForClientUp } from "../core/win/lcu.ts";
import { countPendingRestores, countRestoreWorkload } from "../packs/inventory.ts";
import { langSources, voiceGroups } from "../packs/wad.ts";
import { applyIngameLang, restoreIngameLang } from "./ingameLang.ts";
import { applyIngameVoice, restoreIngameVoice } from "./ingameVoice.ts";
import { applyLobbyLangEn, restoreLobbyLangZh } from "./lobbyLang.ts";
import { applyLobbyVoice, restoreLobbyVoice } from "./lobbyVoice.ts";
import type { SwitchEnv } from "./context.ts";

const logger = createLogger("oneclick");

export interface RunOptions {
  locale: string;
  modules: ModuleId[];
  /** 全部成功后自动重启客户端 UX。 */
  restartClient?: boolean;
  progress?: ProgressReporter;
  signal?: AbortSignal;
  /** 大厅界面语言: "en_US" 时一并切成英文界面。 */
  lobbyLang?: "keep" | "en_US" | "zh_CN";
}

export interface RunOutcome {
  ok: boolean;
  partial: boolean;
  restarted: boolean;
  message: string;
  summary: ResultSummary;
  results: ModuleResult[];
}

/** 把子步骤进度折算到总进度上。 */
function offsetProgress(progress: ProgressReporter | undefined, base: number, total: number): ProgressReporter | undefined {
  if (!progress) return undefined;
  return (done: number, _moduleTotal: number, current?: string) => {
    progress(Math.min(total, base + done), total, current ?? "");
  };
}

/** 开启: 大厅语音 + 对局语音 + 对局语言。 */
export async function applyAll(env: SwitchEnv, options: RunOptions): Promise<RunOutcome> {
  const modules = options.modules.length ? options.modules : (["lobby_voice", "ingame_voice", "ingame_lang"] as ModuleId[]);
  const results: ModuleResult[] = [];
  logger.info(`一键开启 locale=${options.locale} modules=${modules.join(",")}`);

  if (!env.resolution.ok) {
    return {
      ok: false,
      partial: false,
      restarted: false,
      message: env.resolution.message,
      summary: { ok: false, partial: false, lines: [], failed: [] },
      results: []
    };
  }

  const sizes: Record<string, number> = {};
  for (const module of modules) {
    if (module === "ingame_voice") {
      const groups = await voiceGroups(options.locale, env.voiceRoot, env.finalDir ?? env.voiceRoot);
      sizes[module] = Math.max(1, groups.reduce((sum, group) => sum + group.sources.length, 0));
    } else if (module === "ingame_lang") {
      sizes[module] = Math.max(1, (await langSources(options.locale, env.voiceRoot)).length || 1);
    } else {
      sizes[module] = 1;
    }
  }
  const total = Object.values(sizes).reduce((sum, value) => sum + value, 0) || 1;
  options.progress?.(0, total, "正在准备…");

  let base = 0;
  for (const module of modules) {
    if (options.signal?.aborted) break;
    const size = sizes[module] ?? 1;
    const progress = offsetProgress(options.progress, base, total);
    if (module === "lobby_voice") {
      results.push(await applyLobbyVoice(options.locale, env, { progress, signal: options.signal }));
    } else if (module === "ingame_voice") {
      results.push(await applyIngameVoice(options.locale, { voiceRoot: env.voiceRoot, finalDir: env.finalDir, leagueDir: env.leagueDir, progress, signal: options.signal }));
    } else if (module === "ingame_lang") {
      results.push(await applyIngameLang(options.locale, { voiceRoot: env.voiceRoot, finalDir: env.finalDir, leagueDir: env.leagueDir, progress, signal: options.signal }));
    }
    base += size;
  }

  if (options.lobbyLang === "en_US") {
    results.push(await applyLobbyLangEn(env));
  }

  const summary = summarize(results);
  let restarted = false;
  if (summary.ok && options.restartClient !== false && (await isClientRunning())) {
    const restart = await restartClientUx();
    restarted = restart.ok;
    if (restarted) await waitForClientUp(90000);
  }
  options.progress?.(total, total);
  return {
    ok: summary.ok,
    partial: summary.partial,
    restarted,
    message: summary.ok
      ? `已切换到 ${options.locale}${restarted ? "，客户端正在自动重启生效…" : "，启动客户端后生效。"}`
      : (summary.partial ? "部分成功：" : "切换失败：") + summary.lines.join("；"),
    summary,
    results
  };
}

/** 还原: 大厅语音 + 大厅界面语言 + 对局语音 + 对局语言。 */
export async function restoreAll(env: SwitchEnv, options: Omit<RunOptions, "locale"> & { locale?: string }): Promise<RunOutcome> {
  if (await isGameRunning()) {
    return {
      ok: false,
      partial: false,
      restarted: false,
      message: "检测到游戏对局正在进行中，请退出对局后再还原！",
      summary: { ok: false, partial: false, lines: [], failed: [] },
      results: []
    };
  }

  const counts = await countPendingRestores(env.finalDir);
  const total = (await countRestoreWorkload(env.finalDir)) || 2;
  options.progress?.(0, total, "正在准备…");

  let restarted = false;
  if (options.restartClient !== false && (await isClientRunning())) {
    // 客户端占着 d3d9.dll/配置文件时, 先重启 UX 拿到干净的文件句柄
    await restartClientUx();
    restarted = true;
    await waitForClientUp(90000);
  }

  const baseLobbyLang = counts.lobby_voice;
  const baseVoice = baseLobbyLang + counts.lobby_lang;
  const baseLang = baseVoice + counts.ingame_voice;

  const results: ModuleResult[] = [
    await restoreLobbyVoice(env, {
      progress: offsetProgress(options.progress, 0, total),
      signal: options.signal
    }),
    await restoreLobbyLangZh(env),
    await restoreIngameVoice({
      voiceRoot: env.voiceRoot,
      finalDir: env.finalDir,
      leagueDir: env.leagueDir,
      progress: offsetProgress(options.progress, baseVoice, total),
      signal: options.signal
    }),
    await restoreIngameLang({
      voiceRoot: env.voiceRoot,
      finalDir: env.finalDir,
      leagueDir: env.leagueDir,
      progress: offsetProgress(options.progress, baseLang, total),
      signal: options.signal
    })
  ];

  const summary = summarize(results);
  options.progress?.(total, total);
  return {
    ok: summary.ok,
    partial: summary.partial,
    restarted,
    message: summary.ok
      ? `已恢复为官方默认国服原版${restarted ? "，客户端正在自动重启生效…" : "，启动客户端后生效。"}`
      : (summary.partial ? "部分失败：" : "还原失败：") + summary.lines.join("；"),
    summary,
    results
  };
}
