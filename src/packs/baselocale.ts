/**
 * 基准语种(baseLocale): 客户端当前使用的语种 —— 决定了"要替换哪个槽位文件"。
 *
 * 国服客户端: Champions 目录里是 <名字>.zh_CN.wad.client
 * 国际服客户端: 可能是 <名字>.en_US.wad.client / .zh_TW.wad.client ...
 * 因此目标文件名绝不能用某个固定语种写死, 必须跟着客户端实际语种走。
 *
 * 探测优先级: 配置显式指定 > 客户端当前设置 > 唯一游戏语种 > 渠道兜底。
 * 多语种安装无法凭文件数量确定当前使用哪一套，缺少设置时必须说明歧义。
 */
import path from "node:path";
import { isDirectory, listNames, readTextFile } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";
import { pathsEquivalent, readClientLocale, settingsYamlPath } from "../core/paths.ts";
import { findClientExeDir } from "../core/win/processes.ts";

const logger = createLogger("base-locale");

export const DEFAULT_BASE_LOCALE = "zh_CN";

/** 目标槽位后缀: <名字>.zh_CN.wad.client 里的 ".zh_CN.wad.client"。 */
export function wadSuffix(locale: string): string {
  return `.${locale}.wad.client`;
}

export type BaseLocaleSource = "config" | "game-files" | "client-settings" | "default" | "ambiguous";

export interface BaseLocaleInfo {
  locale: string;
  source: BaseLocaleSource;
  detail: string;
  /** 各语种在游戏文件里的出现次数(诊断用)。 */
  tally: Record<string, number>;
}

export interface BaseLocaleOptions {
  finalDir: string | null;
  leagueDir: string | null;
  /** 配置里显式指定的基准语种(空=自动)。 */
  configured?: string;
  /** 渠道自带的语种: 什么都探测不到时用它(国服 zh_CN / 外服 en_US)。缺省 zh_CN。 */
  fallbackLocale?: string;
}

const LOCALE_SUFFIX = /\.([a-z]{2}_[A-Z]{2})\.wad\.client$/;

/** 统计目录里各语种 wad 的数量，仅作诊断与单语种回退。 */
async function tallyFromGameFiles(finalDir: string): Promise<Record<string, number>> {
  const tally: Record<string, number> = {};
  const directories = [
    path.join(finalDir, "Champions"),
    path.join(finalDir, "Maps", "Shipping"),
    path.join(finalDir, "Localized")
  ];
  for (const directory of directories) {
    if (!(await isDirectory(directory))) continue;
    for (const name of await listNames(directory)) {
      const match = LOCALE_SUFFIX.exec(name);
      if (!match) continue;
      const code = match[1]!;
      tally[code] = (tally[code] ?? 0) + 1;
    }
  }
  return tally;
}

/** 读客户端设置里的 locale(国际服/国服都写在 LeagueClientSettings.yaml)。 */
async function localeFromClientSettings(leagueDir: string): Promise<string | null> {
  const file = await settingsYamlPath({ leagueDir });
  const text = file ? await readTextFile(file) : null;
  return text ? readClientLocale(text) : null;
}

/**
 * 直接问客户端自己是什么语种(最权威: 客户端一定知道自己的语种)。
 *
 * 客户端没开 / 老版本没有这个接口时返回 null —— 只当补充来源, 失败不影响其它来源。
 * 这一步很关键: 用户的客户端可能是韩文、繁中、西语…… 只要问得到, 就绝不会写错槽位。
 */
async function localeFromClient(leagueDir: string | null): Promise<string | null> {
  // 配置可能指向离线安装；另一份正在运行的客户端不能替它决定语种。
  if (!leagueDir || !pathsEquivalent(await findClientExeDir(), leagueDir)) return null;
  try {
    const { lcuRequest } = await import("../core/win/lcu.ts");
    const response = await lcuRequest("GET", "/riotclient/region-locale", { timeoutMs: 2500 });
    if (response.status !== 200 || !response.body) return null;
    const value = (JSON.parse(response.body) as { locale?: unknown })?.locale;
    return typeof value === "string" && /^[a-z]{2}_[A-Z]{2}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 解析基准语种。
 * 文件数只用于诊断：多语种安装的数量差不能代表当前语种。
 */
export async function detectBaseLocale(options: BaseLocaleOptions): Promise<BaseLocaleInfo> {
  const configured = (options.configured ?? "").trim();

  let tally: Record<string, number> = {};
  if (options.finalDir && (await isDirectory(options.finalDir))) {
    tally = await tallyFromGameFiles(options.finalDir);
  }

  if (configured) {
    return { locale: configured, source: "config", detail: "配置指定", tally };
  }

  const fromSettings = options.leagueDir ? await localeFromClientSettings(options.leagueDir) : null;
  if (fromSettings) {
    return { locale: fromSettings, source: "client-settings", detail: `客户端当前语种 ${fromSettings}（游戏文件里 ${tally[fromSettings] ?? 0} 个）`, tally };
  }

  // 设置文件读不到时, 直接问客户端本身(客户端没开就跳过, 不阻塞)。
  const fromClient = await localeFromClient(options.leagueDir);
  if (fromClient) {
    return {
      locale: fromClient,
      source: "client-settings",
      detail: `客户端当前语种 ${fromClient}（来自客户端接口）`,
      tally
    };
  }

  const entries = Object.entries(tally);
  if (entries.length === 1) {
    const [locale, count] = entries[0]!;
    return { locale, source: "game-files", detail: `游戏文件只有 ${locale}，共 ${count} 个`, tally };
  }

  const fallback = (options.fallbackLocale ?? "").trim() || DEFAULT_BASE_LOCALE;
  const seen = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `${code}:${count}`)
    .join(" ");
  if (entries.length > 1) {
    const detail = `无法确定客户端当前语种（游戏文件统计 ${seen}）。请确认该安装的 Config/LeagueClientSettings.yaml 中 locale 项可读，或在工具配置中指定 baseLocale。`;
    logger.warn(detail);
    return { locale: fallback, source: "ambiguous", detail, tally };
  }
  logger.warn(`未探测到基准语种, 使用渠道兜底值 ${fallback}(游戏文件统计: ${seen || "无"})`);
  return {
    locale: fallback,
    source: "default",
    detail: `未探测到，使用该渠道自带语种 ${fallback}（游戏文件统计 ${seen || "无"}）`,
    tally
  };
}

export type ClientRegion = "cn" | "global";

/** 客户端渠道: 国服(WeGame/Tencent) 还是国际服(Riot)。 */
export function detectRegion(leagueDir: string | null, sourceDetail = ""): ClientRegion {
  const text = `${leagueDir ?? ""} ${sourceDetail}`;
  if (!text.trim()) return "cn";
  if (/riot\s*games/i.test(text)) return "global";
  if (/wegame|tencent|tcls|英雄联盟/i.test(text)) return "cn";
  if (/league\s*of\s*legends/i.test(text)) return "global";
  return "cn";
}
