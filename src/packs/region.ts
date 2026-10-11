/**
 * 渠道(国服 / 外服)的差异集中在这里 —— **右上角按钮的状态决定用哪一套**。
 *
 * 为什么要分开: 两个渠道的客户端来源、自带语种、资源下载地址都不一样。
 *   国服: WeGame/Tencent 客户端, 自带中文(zh_CN), 资源走国内镜像(直连官方 CDN 基本拉不动);
 *   外服: Riot 客户端, 自带英文(通常 en_US), 资源直接从 Riot 官方 CDN 取, 不需要国内镜像。
 *
 * 这里只描述"方式", 不做探测; 探测结果与按钮状态的取舍见 resolveRegion()。
 */
import type { ClientRegion } from "./baselocale.ts";

/** 国服默认的资源代理与清单(与 config 默认值保持一致, 用于判断用户有没有自己改过)。 */
export const CN_BUNDLE_PROXY = "https://gh.chosen.cc.cd/channels/public/bundles";
export const CN_MANIFEST_ID = "37D5BB71755990B9";

export interface RegionProfile {
  region: ClientRegion;
  label: string;
  /** 客户端自带语种: 探测不到任何依据时用它决定替换哪个槽位。 */
  fallbackBaseLocale: string;
  /** 资源包下载基址(bundleProxy 的渠道默认值)。 */
  bundleBase: string;
  /** 清单文件的来源 origin。 */
  manifestOrigin: string;
  /** 该渠道已知的清单 ID(外服随版本变化, 留空表示要用配置或本地清单)。 */
  manifestId: string;
  /** 给人看的一句话说明(界面/日志/CLI 共用)。 */
  detail: string;
}

export const REGION_PROFILES: Record<ClientRegion, RegionProfile> = {
  cn: {
    region: "cn",
    label: "国服",
    fallbackBaseLocale: "zh_CN",
    bundleBase: CN_BUNDLE_PROXY,
    manifestOrigin: "https://gh.chosen.cc.cd",
    manifestId: CN_MANIFEST_ID,
    detail: "WeGame/Tencent 客户端 · 自带中文 · 资源走国内镜像"
  },
  global: {
    region: "global",
    label: "外服",
    fallbackBaseLocale: "en_US",
    bundleBase: "https://lol.secure.dyn.riotcdn.net/channels/public/bundles",
    manifestOrigin: "https://lol.secure.dyn.riotcdn.net",
    manifestId: "",
    detail: "Riot 客户端 · 自带英文 · 资源直连 Riot 官方 CDN"
  }
};

export type RegionSource = "ui" | "detected";

export function regionProfile(region: ClientRegion): RegionProfile {
  return REGION_PROFILES[region];
}

/**
 * 右上角按钮优先: 显式选了国服/外服就按它走, 只有 auto 才用路径探测的结果。
 */
export function resolveRegion(
  preference: string | null | undefined,
  detected: ClientRegion
): { region: ClientRegion; source: RegionSource } {
  const value = (preference ?? "").trim().toLowerCase();
  if (value === "cn" || value === "global") return { region: value, source: "ui" };
  return { region: detected, source: "detected" };
}

export interface DownloadProfile {
  bundleBase: string;
  manifestOrigin: string;
  manifestId: string;
}

/**
 * 下载资源时实际用哪套地址。
 * 用户显式改过 bundleProxy / manifestId 就听用户的; 还是默认值(国服那套)就换成本渠道的。
 */
export function downloadProfile(
  config: { bundleProxy?: string; manifestId?: string },
  region: ClientRegion
): DownloadProfile {
  const profile = regionProfile(region);
  const bundle = (config.bundleProxy ?? "").trim();
  const manifestId = (config.manifestId ?? "").trim();
  const bundleIsDefault = !bundle || bundle === CN_BUNDLE_PROXY;
  const manifestIsDefault = !manifestId || manifestId === CN_MANIFEST_ID;
  const bundleBase = bundleIsDefault ? profile.bundleBase : bundle;
  let manifestOrigin = profile.manifestOrigin;
  try {
    manifestOrigin = new URL(bundleBase).origin;
  } catch {
    /* 配置里的地址不是合法 URL: 保持渠道默认的 origin */
  }
  return { bundleBase, manifestOrigin, manifestId: manifestIsDefault ? profile.manifestId : manifestId };
}
