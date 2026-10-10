/**
 * wad 资源匹配与目标命名。
 *
 * 只接受 <名字>.<locale>.wad.client 或完全没有语种后缀的 <名字>.wad.client,
 * 绝不把 ko_KR 之类其它语种的文件当成本语种资源替换进国服目录。
 */
import path from "node:path";
import { walkFiles } from "../core/fsx.ts";
import { isWadFile } from "./locales.ts";

export const WAD_EXT = ".wad.client";

/** 取 wad 的"资源名": 去掉 .wad.client 后再取第一个点之前的部分。 */
export function wadStem(input: string): string {
  const name = path.basename(input);
  const withoutExt = name.endsWith(WAD_EXT) ? name.slice(0, -WAD_EXT.length) : name;
  return withoutExt.split(".")[0] ?? withoutExt;
}

/** 目标文件名统一写成国服槽位: <资源名>.zh_CN.wad.client */
export function targetFileName(src: string, suffix = ".zh_CN.wad.client"): string {
  return `${wadStem(src)}${suffix}`;
}

export interface MatchOptions {
  recursive?: boolean;
  /** 只接受指定资源名(语言包必须限定 Global, 否则会把别的 wad 写到错误目标)。 */
  stem?: string;
}

/** 按语种匹配目录里的 wad 资源(语种精确匹配优先于无后缀)。 */
export async function matchLocaleFiles(directory: string, locale: string, options: MatchOptions = {}): Promise<string[]> {
  const files = await walkFiles(directory, { recursive: options.recursive ?? false, match: isWadFile });
  const suffix = `.${locale}${WAD_EXT}`;
  const exact = new Map<string, string>();
  const plain = new Map<string, string>();
  for (const file of files) {
    const name = path.basename(file);
    if (name.endsWith(suffix)) {
      const key = name.slice(0, -suffix.length);
      if (!exact.has(key)) exact.set(key, file);
      continue;
    }
    const withoutExt = name.slice(0, -WAD_EXT.length);
    if (withoutExt.includes(".")) continue; // 带别的语种后缀: 不收
    if (!plain.has(withoutExt)) plain.set(withoutExt, file);
  }
  const merged = new Map<string, string>([...plain, ...exact]);
  return [...merged.keys()]
    .filter((key) => !options.stem || key === options.stem)
    .sort()
    .map((key) => merged.get(key)!);
}

/** 某个分组的目标槽位数量(资源缺失时界面显示 0/N 用)。 */
export async function targetSlotCount(directory: string): Promise<number> {
  const files = await walkFiles(directory, { match: (name) => name.endsWith(".zh_CN.wad.client") });
  return files.length;
}

export interface ResourceGroup {
  name: string;
  sources: string[];
  destDir: string;
}

/** 对局语音的两组替换计划: 英雄台词 + 地图/播报员。 */
export async function voiceGroups(locale: string, voiceRoot: string, finalDir: string): Promise<ResourceGroup[]> {
  const resFinal = path.join(voiceRoot, locale, "DATA", "FINAL");
  const [champions, maps] = await Promise.all([
    matchLocaleFiles(path.join(resFinal, "Champions"), locale),
    matchLocaleFiles(path.join(resFinal, "Maps", "Shipping"), locale, { recursive: true })
  ]);
  return [
    { name: "champions", sources: champions, destDir: path.join(finalDir, "Champions") },
    { name: "maps", sources: maps, destDir: path.join(finalDir, "Maps", "Shipping") }
  ];
}

/** 游戏内语言包源文件(限定 Global)。 */
export async function langSources(locale: string, voiceRoot: string): Promise<string[]> {
  const dir = path.join(voiceRoot, locale, "DATA", "FINAL", "Localized");
  return matchLocaleFiles(dir, locale, { stem: "Global" });
}
