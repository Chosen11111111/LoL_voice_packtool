/** 语种目录识别与扫描。 */
import path from "node:path";
import { countFiles, hasAnyFile, isDirectory, listNames } from "../core/fsx.ts";
import type { LocaleInfo } from "../core/types.ts";

export const LOCALE_NAMES: Record<string, string> = {
  ja_JP: "日服 (ja_JP)",
  ko_KR: "韩服 (ko_KR)",
  en_US: "美服 (en_US)",
  zh_CN: "国服中文 (zh_CN)",
  zh_TW: "台服繁体 (zh_TW)",
  de_DE: "德服 (de_DE)",
  fr_FR: "法服 (fr_FR)",
  es_ES: "西服 (es_ES)",
  es_MX: "拉美服 (es_MX)",
  ru_RU: "俄服 (ru_RU)",
  it_IT: "意服 (it_IT)",
  pl_PL: "波兰服 (pl_PL)",
  pt_BR: "巴西服 (pt_BR)",
  tr_TR: "土耳其服 (tr_TR)",
  vi_VN: "越南服 (vi_VN)",
  th_TH: "泰服 (th_TH)",
  ar_AE: "阿服 (ar_AE)",
  en_GB: "英服 (en_GB)",
  en_AU: "澳服 (en_AU)"
};

/** CommunityDragon 用的语种目录名(en_US 走 default)。 */
export const CDN_LOCALE_MAP: Record<string, string> = {
  ja_JP: "ja_jp",
  ko_KR: "ko_kr",
  en_US: "default",
  zh_CN: "zh_cn",
  zh_TW: "zh_tw",
  de_DE: "de_de",
  fr_FR: "fr_fr",
  es_ES: "es_es",
  es_MX: "es_mx",
  ru_RU: "ru_ru"
};

const LOCALE_CODE_PATTERN = /^[a-z]{2}_[A-Z]{2}$/;

const EXCLUDED_DIRS = new Set(["scratch_champ_select", "assets", "__pycache__", "DATA", "plugins"]);

export function isLocaleCode(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(LOCALE_NAMES, name) || LOCALE_CODE_PATTERN.test(name);
}

export function localeDisplayName(code: string): string {
  return LOCALE_NAMES[code] ?? `${code} 语言包`;
}

export function cdnLocale(code: string): string {
  return CDN_LOCALE_MAP[code] ?? "default";
}

export function isWadFile(name: string): boolean {
  return name.endsWith(".wad.client");
}

export function isOggFile(name: string): boolean {
  return name.toLowerCase().endsWith(".ogg");
}

/** 一个语种包在各部分资源上的实际文件数。 */
export async function countLocaleFiles(root: string, code: string): Promise<{
  voice: number;
  maps: number;
  lang: number;
  lobby: number;
}> {
  const final = path.join(root, code, "DATA", "FINAL");
  const lobbyDir = await lobbyAssetsDir(code, root);
  const [voice, maps, lang, lobby] = await Promise.all([
    countFiles(path.join(final, "Champions"), isWadFile),
    countFiles(path.join(final, "Maps"), isWadFile, true),
    countFiles(path.join(final, "Localized"), isWadFile),
    lobbyDir ? countFiles(path.join(lobbyDir, "champion-choose-vo"), isOggFile) : Promise.resolve(0)
  ]);
  return { voice, maps, lang, lobby };
}

/** 目录是否为真正的多语种语言包(必须实际含资源, 不接受空壳目录)。 */
export async function isLocaleFolder(dir: string, root: string, name = path.basename(dir)): Promise<boolean> {
  if (!(await isDirectory(dir))) return false;
  if (name.startsWith(".") || name.startsWith("_") || EXCLUDED_DIRS.has(name)) return false;
  if (!isLocaleCode(name)) return false;

  const final = path.join(dir, "DATA", "FINAL");
  const [hasChamp, hasLoc, hasMap, hasLobby] = await Promise.all([
    hasAnyFile(path.join(final, "Champions"), isWadFile),
    hasAnyFile(path.join(final, "Localized"), isWadFile),
    hasAnyFile(path.join(final, "Maps"), isWadFile, true),
    lobbyAssetsDir(name, root).then(async (dir2) => (dir2 ? hasAnyFile(path.join(dir2, "champion-choose-vo"), isOggFile) : false))
  ]);
  return hasChamp || hasLoc || hasMap || hasLobby;
}

/** 大厅选人语音资源目录: <root>/<locale>/assets 或 <root>/assets/<locale>。 */
export async function lobbyAssetsDir(code: string, root: string): Promise<string | null> {
  const candidates = [path.join(root, code, "assets"), path.join(root, "assets", code)];
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return candidate;
  }
  return null;
}

export interface ScanOptions {
  /** 附带逐项文件数统计(会遍历目录, 大包会慢一些)。 */
  withCounts?: boolean;
  /** 只保留这些语种。 */
  only?: string[];
}

/** 扫描可用语言包列表。路径无效或无有效包时返回空数组, 绝不伪造。 */
export async function scanLocales(root: string, options: ScanOptions = {}): Promise<LocaleInfo[]> {
  if (!(await isDirectory(root))) return [];
  const only = options.only && options.only.length ? new Set(options.only) : null;
  const locales: LocaleInfo[] = [];
  for (const name of (await listNames(root)).sort()) {
    if (only && !only.has(name)) continue;
    const dir = path.join(root, name);
    if (!(await isLocaleFolder(dir, root, name))) continue;
    const counts = options.withCounts
      ? await countLocaleFiles(root, name)
      : { voice: 0, maps: 0, lang: 0, lobby: 0 };
    locales.push({
      code: name,
      name: localeDisplayName(name),
      has_voice: options.withCounts ? counts.voice > 0 : await hasAnyFile(path.join(dir, "DATA", "FINAL", "Champions"), isWadFile),
      has_lang: options.withCounts ? counts.lang > 0 : await hasAnyFile(path.join(dir, "DATA", "FINAL", "Localized"), isWadFile),
      has_maps: options.withCounts ? counts.maps > 0 : await hasAnyFile(path.join(dir, "DATA", "FINAL", "Maps"), isWadFile, true),
      has_lobby: options.withCounts ? counts.lobby > 0 : await lobbyAssetsDir(name, root).then(async (dir2) => (dir2 ? hasAnyFile(path.join(dir2, "champion-choose-vo"), isOggFile) : false)),
      voice_files: counts.voice,
      map_files: counts.maps,
      lang_files: counts.lang,
      lobby_files: counts.lobby,
      root
    });
  }
  return locales;
}
