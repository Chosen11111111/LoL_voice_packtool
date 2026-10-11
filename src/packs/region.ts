/**
 * 渠道(国服 / 外服)的差异集中在这里 —— **右上角按钮的状态决定用哪一套**。
 *
 * 为什么要分开:
 *   国服: WeGame/Tencent 客户端, 自带中文(zh_CN), 客户端目录与界面文案都不同;
 *   外服: Riot 客户端, 自带英文(通常 en_US)。
 *
 * 这里只描述"方式", 不做探测; 探测结果与按钮状态的取舍见 resolveRegion()。
 * (资源增量下载已从项目里删除 —— 语音包一律用压缩包/文件夹导入, 两个渠道通用。)
 */
import type { ClientRegion } from "./baselocale.ts";

export interface RegionProfile {
  region: ClientRegion;
  label: string;
  /** 客户端自带语种: 什么都探测不到时用它决定要替换哪个槽位。 */
  fallbackBaseLocale: string;
  /** 给人看的一句话说明(界面/日志/CLI 共用)。 */
  detail: string;
}

export const REGION_PROFILES: Record<ClientRegion, RegionProfile> = {
  cn: {
    region: "cn",
    label: "国服",
    fallbackBaseLocale: "zh_CN",
    detail: "WeGame/Tencent 客户端 · 自带中文"
  },
  global: {
    region: "global",
    label: "外服",
    fallbackBaseLocale: "en_US",
    detail: "Riot 客户端 · 自带英文"
  }
};

export type RegionSource = "ui" | "detected";

export function regionProfile(region: ClientRegion): RegionProfile {
  return REGION_PROFILES[region];
}

/** 右上角按钮优先: 显式选了国服/外服就按它走, 只有 auto 才用路径探测的结果。 */
export function resolveRegion(
  preference: string | null | undefined,
  detected: ClientRegion
): { region: ClientRegion; source: RegionSource } {
  const value = (preference ?? "").trim().toLowerCase();
  if (value === "cn" || value === "global") return { region: value, source: "ui" };
  return { region: detected, source: "detected" };
}
