/** 一键操作: 按勾选模块顺序执行, 进度按工作量折算成一条总进度。 */
import { createLogger } from "../core/logger.ts";
import { summarize, type ModuleResult, type ResultSummary } from "../core/result.ts";
import type { ModuleId, ProgressReporter } from "../core/types.ts";
import { isClientRunning, isGameRunning } from "../core/win/processes.ts";
import { restartClientUx, waitForClientUp } from "../core/win/lcu.ts";
import { countPendingRestores } from "../packs/inventory.ts";
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
  /** 是否装了"客户端界面文字"(它没有模块可切, 但注入只在客户端启动时发生, 同样要重启一次)。 */
  clientText?: boolean;
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
function offsetProgress(progress: ProgressReporter | undefined, base: number, total: number, size: number): ProgressReporter | undefined {
  if (!progress) return undefined;
  return (done: number, moduleTotal: number, current?: string) => {
    progress(base + Math.min(size, moduleTotal > 0 ? Math.max(0, done / moduleTotal) * size : 0), total, current ?? "");
  };
}

function stoppedOutcome(message: string, results: ModuleResult[] = []): RunOutcome {
  const summary = { ...summarize(results), ok: false, partial: results.some((item) => item.success > 0) };
  return { ok: false, partial: summary.partial, restarted: false, message, summary, results };
}

/** 开启: 大厅语音 + 对局语音 + 对局语言。 */
export async function applyAll(env: SwitchEnv, options: RunOptions): Promise<RunOutcome> {
  // 空数组就是"一个都不切"。以前这里用 options.modules.length 判断, 空数组在 JS 里是"假",
  // 会被换成默认那三项(大厅语音/对局语音/对局文字) —— 用户"只勾客户端文字"时实测踩到过。
  const modules = [...new Set<ModuleId>(options.modules)];
  if (modules.length === 0) {
    // 一个模块都没勾(例如只勾了"客户端界面文字"): 没有文件要切, 但注入只发生在客户端启动的那一刻,
    // 所以还是要重启一次 —— 用的就是下面那条和对局语音完全相同的路径。什么都没切不算失败。
    let onlyRestart = false;
    if (options.clientText === true && options.restartClient !== false && (await isClientRunning())) {
      const restart = await restartClientUx();
      onlyRestart = restart.ok;
      if (onlyRestart) await waitForClientUp(90000);
    }
    return {
      ok: true, partial: false, restarted: onlyRestart,
      message: onlyRestart ? "已开启客户端界面文字，并重启了客户端" : "没有勾选任何要切换的内容",
      summary: { ok: true, partial: false, lines: [], failed: [] },
      results: []
    };
  }
  const results: ModuleResult[] = [];
  logger.info(`一键开启 locale=${options.locale} modules=${modules.join(",")}`);
  if (options.signal?.aborted) return stoppedOutcome("已取消");

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
  if (modules.some((module) => module.startsWith("ingame_")) && env.baseLocaleSource === "ambiguous") {
    return stoppedOutcome(env.baseLocaleDetail);
  }
  if (modules.some((module) => module.startsWith("ingame_")) && await isGameRunning()) {
    return stoppedOutcome("检测到游戏对局正在进行中，请退出对局后再切换！");
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
  const extraLang = options.lobbyLang === "en_US" && !modules.includes("lobby_lang");
  const total = Object.values(sizes).reduce((sum, value) => sum + value, extraLang ? 1 : 0) || 1;
  options.progress?.(0, total, "正在准备…");

  let base = 0;
  for (const module of modules) {
    if (options.signal?.aborted) break;
    const size = sizes[module] ?? 1;
    const progress = offsetProgress(options.progress, base, total, size);
    if (module === "lobby_voice") {
      results.push(await applyLobbyVoice(options.locale, env, { progress, signal: options.signal }));
    } else if (module === "ingame_voice") {
      results.push(await applyIngameVoice(options.locale, { voiceRoot: env.voiceRoot, finalDir: env.finalDir, leagueDir: env.leagueDir, baseLocale: env.baseLocale, progress, signal: options.signal }));
    } else if (module === "ingame_lang") {
      results.push(await applyIngameLang(options.locale, { voiceRoot: env.voiceRoot, finalDir: env.finalDir, leagueDir: env.leagueDir, baseLocale: env.baseLocale, progress, signal: options.signal }));
    } else if (module === "lobby_lang") {
      results.push(await applyLobbyLangEn(env));
    }
    base += size;
    if (!options.signal?.aborted) options.progress?.(base, total);
  }

  if (options.signal?.aborted) return stoppedOutcome("已取消", results);
  if (extraLang) {
    results.push(await applyLobbyLangEn(env));
  }

  const summary = summarize(results);
  let restarted = false;
  if ((options.clientText === true || modules.some((module) => module !== "lobby_voice")) && options.restartClient !== false && (await isClientRunning())) {
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
  if (options.signal?.aborted) return stoppedOutcome("已取消");
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
  const modules = [...new Set<ModuleId>(options.modules)];
  if (modules.length === 0) {
    // 一个模块都没勾(例如用户只开了"客户端界面文字"): 什么都不做, 但这是成功, 不是失败。
    return {
      ok: true, partial: false, restarted: false,
      message: "没有勾选任何要切换的内容",
      summary: { ok: true, partial: false, lines: [], failed: [] },
      results: []
    };
  }
  const total = modules.reduce((sum, module) => sum + Math.max(1, counts[module]), 0);
  options.progress?.(0, total, "正在准备…");

  let restarted = false;
  if ((options.clientText === true || modules.some((module) => module !== "lobby_voice")) && options.restartClient !== false && (await isClientRunning())) {
    // 客户端占着 d3d9.dll/配置文件时, 先重启 UX 拿到干净的文件句柄
    const restart = await restartClientUx();
    restarted = restart.ok;
    if (restarted) await waitForClientUp(90000);
  }

  const results: ModuleResult[] = [];
  let base = 0;
  for (const module of modules) {
    if (options.signal?.aborted) return { ...stoppedOutcome("已取消", results), restarted };
    const size = Math.max(1, counts[module]);
    const progress = offsetProgress(options.progress, base, total, size);
    const context = { voiceRoot: env.voiceRoot, finalDir: env.finalDir, leagueDir: env.leagueDir, baseLocale: env.baseLocale, progress, signal: options.signal };
    if (module === "lobby_voice") results.push(await restoreLobbyVoice(env, { progress, signal: options.signal }));
    else if (module === "lobby_lang") results.push(await restoreLobbyLangZh(env));
    else if (module === "ingame_voice") results.push(await restoreIngameVoice(context));
    else if (module === "ingame_lang") results.push(await restoreIngameLang(context));
    base += size;
    if (!options.signal?.aborted) options.progress?.(base, total);
  }
  if (options.signal?.aborted) return { ...stoppedOutcome("已取消", results), restarted };

  const summary = summarize(results);
  options.progress?.(total, total);
  return {
    ok: summary.ok,
    partial: summary.partial,
    restarted,
    message: summary.ok
      ? `已恢复为该客户端原版${restarted ? "，客户端正在自动重启生效…" : "，启动客户端后生效。"}`
      : (summary.partial ? "部分失败：" : "还原失败：") + summary.lines.join("；"),
    summary,
    results
  };
}
