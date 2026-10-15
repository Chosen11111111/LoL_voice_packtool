/**
 * 基准语种(baseLocale): 客户端当前使用的语种 —— 决定了"要替换哪个槽位文件"。
 *
 * 国服客户端: Champions 目录里是 <名字>.zh_CN.wad.client
 * 国际服客户端: 可能是 <名字>.en_US.wad.client / .zh_TW.wad.client ...
 * 因此目标文件名绝不能用某个固定语种写死, 必须跟着客户端实际语种走。
 *
 * 探测优先级: 配置显式指定 > 游戏文件里的语种后缀统计 > 客户端设置 locale > zh_CN(兜底)
 */
import path from "node:path";
import { isDirectory, listNames, readTextFile } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";

const logger = createLogger("base-locale");

export const DEFAULT_BASE_LOCALE = "zh_CN";

/** 目标槽位后缀: <名字>.zh_CN.wad.client 里的 ".zh_CN.wad.client"。 */
export function wadSuffix(locale: string): string {
  return `.${locale}.wad.client`;
}

export type BaseLocaleSource = "config" | "game-files" | "client-settings" | "default";

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

/** 统计目录里各语种 wad 的数量, 取最多的作为基准语种。 */
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
  // 实测真实位置多一层 LeagueClient: <客户端>/LeagueClient/Config/LeagueClientSettings.yaml
  // (老代码只找 <客户端>/Config/..., 于是这条来源永远读不到)
  const candidates = [
    path.join(leagueDir, "LeagueClient", "Config", "LeagueClientSettings.yaml"),
    path.join(leagueDir, "Config", "LeagueClientSettings.yaml")
  ];
  for (const file of candidates) {
    const text = await readTextFile(file);
    if (!text) continue;
    // 引号可有可无: 实测 YAML 里 "en_US" 与 en_US 两种写法都有
    const match = /locale:\s*["']?([A-Za-z]{2}_[A-Za-z]{2})["']?/.exec(text);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * 解析基准语种。
 * 游戏文件的统计结果只在"多数票"成立时采信(最多且严格多于第二名),
 * 这样零星的其它语种残留文件不会把判断带偏; 判断不了再退回客户端设置与兜底值。
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

  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const best = entries[0];
  const runnerUp = entries[1];
  const majority = Boolean(best) && best[1] >= 2 && (!runnerUp || best[1] > runnerUp[1]);
  if (best && majority) {
    return { locale: best[0], source: "game-files", detail: `游戏文件里 ${best[0]} 共 ${best[1]} 个`, tally };
  }

  const fromSettings = options.leagueDir ? await localeFromClientSettings(options.leagueDir) : null;
  if (fromSettings) {
    // 客户端设置里写的语种如果在游戏文件里确实存在, 以文件为准
    if (tally[fromSettings]) {
      return {
        locale: fromSettings,
        source: "game-files",
        detail: `客户端语种 ${fromSettings}（游戏文件里 ${tally[fromSettings]} 个）`,
        tally
      };
    }
    return { locale: fromSettings, source: "client-settings", detail: "客户端设置", tally };
  }

  const fallback = (options.fallbackLocale ?? "").trim() || DEFAULT_BASE_LOCALE;
  const seen = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `${code}:${count}`)
    .join(" ");
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
