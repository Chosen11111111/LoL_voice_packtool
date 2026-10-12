/** 资源校验、状态查询、工作量与磁盘空间估算 —— 一切"只读"的判断都在这里。 */
import path from "node:path";
import {
  backupPath,
  candidateNeedsCopy,
  countBackups,
  fileSize,
  hasAnyFile,
  freeSpaceBytes,
  hasBackup,
  humanBytes,
  isDirectory,
  isFile,
  supportsHardlinks,
  walkFiles
} from "../core/fsx.ts";
import { makeResult, type ModuleResult } from "../core/result.ts";
import type { ModuleId } from "../core/types.ts";
import { isWadFile, localeDisplayName } from "./locales.ts";
import { langSources, matchLocaleFiles, targetSlotCount, voiceGroups } from "./wad.ts";

export const BAK_SUFFIX = ".chosen_bak";
export const CN_WAD_SUFFIX = ".zh_CN.wad.client";

export interface ResourceCheck {
  ok: boolean;
  module: ModuleId;
  module_name: string;
  planned: number;
  success: number;
  failed: number;
  missing: boolean;
  reason: string;
  message: string;
}

/** 按模块校验资源是否齐备(缺资源直接失败并说明缺什么)。 */
export async function checkModuleResources(
  module: ModuleId,
  locale: string,
  context: { voiceRoot: string }
): Promise<ResourceCheck> {
  const base = { module, module_name: moduleResultName(module), success: 0, failed: 0 };

  if (module === "ingame_voice") {
    const final = path.join(context.voiceRoot, locale, "DATA", "FINAL");
    const [champions, maps] = await Promise.all([
      matchLocaleFiles(path.join(final, "Champions"), locale),
      matchLocaleFiles(path.join(final, "Maps", "Shipping"), locale, { recursive: true })
    ]);
    if (!champions.length && !maps.length) {
      return {
        ...base,
        ok: false,
        planned: 0,
        missing: true,
        reason: "资源缺失",
        message:
          `未找到可匹配的 ${locale} 英雄语音或系统播报员文件（仅有大厅选人语音的包不能用于对局语音）。\n` +
          `期望目录：${path.join(final, "Champions")} 或 ${path.join(final, "Maps", "Shipping")}`
      };
    }
    return {
      ...base,
      ok: true,
      planned: champions.length + maps.length,
      missing: false,
      reason: "",
      message: `英雄语音 ${champions.length} 个 / 播报员 ${maps.length} 个`
    };
  }

  if (module === "ingame_lang") {
    const dir = path.join(context.voiceRoot, locale, "DATA", "FINAL", "Localized");
    const sources = await langSources(locale, context.voiceRoot);
    if (!sources.length) {
      return {
        ...base,
        ok: false,
        planned: 0,
        missing: true,
        reason: "资源缺失",
        message: `未找到 ${locale} 的游戏内语言包文件 Localized/Global.${locale}.wad.client\n期望目录：${dir}`
      };
    }
    return { ...base, ok: true, planned: 1, missing: false, reason: "", message: path.basename(sources[0]!) };
  }

  if (module === "lobby_voice") {
    const assets = await lobbyAssetsDir(locale, context.voiceRoot);
    const oggs = assets ? await walkFiles(path.join(assets, "champion-choose-vo"), { match: (name) => name.toLowerCase().endsWith(".ogg") }) : [];
    if (!oggs.length) {
      return {
        ...base,
        ok: false,
        planned: 0,
        missing: true,
        reason: "资源缺失",
        message: `未找到 ${locale} 的大厅选人语音资源 assets/champion-choose-vo/*.ogg（当前资源目录：${context.voiceRoot}）`
      };
    }
    return {
      ...base,
      ok: true,
      planned: 1,
      missing: false,
      reason: "",
      message: `选人语音 ${oggs.length} 个（LCU 监听 + 本地播报，不改客户端文件）`
    };
  }

  if (module === "lobby_lang") {
    return { ...base, ok: true, planned: 1, missing: false, reason: "", message: "客户端界面语言" };
  }

  return { ...base, ok: false, planned: 0, missing: false, reason: "未知模块", message: `未知模块：${module}` };
}

function moduleResultName(module: ModuleId): string {
  return { ingame_voice: "游戏内语音", ingame_lang: "游戏内语言", lobby_voice: "大厅语音", lobby_lang: "大厅界面语言" }[module] ?? module;
}

async function lobbyAssetsDir(code: string, root: string): Promise<string | null> {
  for (const candidate of [path.join(root, code, "assets"), path.join(root, "assets", code)]) {
    if (await isDirectory(candidate)) return candidate;
  }
  return null;
}

export interface PendingRestores {
  lobby_voice: number;
  lobby_lang: number;
  ingame_voice: number;
  ingame_lang: number;
}

/** 未勾选模块需要还原的工作量(用于进度总数)。 */
/** 统计任意语种的 wad 备份(不绑定 zh_CN)。 */
async function countWadBackups(directory: string): Promise<number> {
  const files = await walkFiles(directory, { match: (name) => name.endsWith(`.wad.client${BAK_SUFFIX}`) });
  return files.length;
}

export async function countPendingRestores(finalDir: string | null): Promise<PendingRestores> {
  const counts: PendingRestores = { lobby_voice: 1, lobby_lang: 1, ingame_voice: 0, ingame_lang: 0 };
  if (!finalDir) return counts;
  const [champions, maps] = await Promise.all([
    countWadBackups(path.join(finalDir, "Champions")),
    countWadBackups(path.join(finalDir, "Maps", "Shipping"))
  ]);
  counts.ingame_voice = champions + maps;
  counts.ingame_lang = (await countWadBackups(path.join(finalDir, "Localized"))) > 0 ? 1 : 0;
  return counts;
}

export async function countRestoreWorkload(finalDir: string | null): Promise<number> {
  const counts = await countPendingRestores(finalDir);
  return counts.lobby_voice + counts.lobby_lang + counts.ingame_voice + counts.ingame_lang;
}

export interface IngameStatus {
  ok: boolean;
  message: string;
  voice: string;
  lang: string;
  is_voice_active: boolean;
  is_lang_active: boolean;
  active_locale: string;
  final_dir: string;
  source: string;
  voice_backups: number;
  lang_backup: boolean;
}

/** 对局端当前生效状态。只看正式备份名, 半份 .part 不算。 */
export async function getIngameStatus(options: {
  finalDir: string | null;
  voiceRoot: string;
  locale?: string;
  message?: string;
  source?: string;
}): Promise<IngameStatus> {
  // 当前生效的语种以"本程序上次开启的记录"为准(options.locale);
  // 老工具可能在 language\ 下留过 active_locale.json, 作为次要依据。
  // 注意: 以前这里兜底成 "ja_JP", 结果没记录时状态栏一律显示"日语" —— 与实际切换的语种不符。
  const locale = options.locale ?? "";
  const fromFile = await readActiveLocale(options.voiceRoot, "");
  const activeLocale = locale || fromFile;
  const display = activeLocale ? localeDisplayName(activeLocale) : "";

  if (!options.finalDir) {
    return {
      ok: false,
      message: options.message ?? "未能解析游戏目录",
      voice: "游戏路径未就绪",
      lang: "游戏路径未就绪",
      is_voice_active: false,
      is_lang_active: false,
      active_locale: activeLocale,
      final_dir: "",
      source: options.source ?? "",
      voice_backups: 0,
      lang_backup: false
    };
  }

  const final = options.finalDir;
  // 备份识别不绑定语种: 客户端语种变过或历史遗留的备份都要能被状态查询与还原发现
  const [voiceBackups, langBackup] = await Promise.all([
    countBackups(path.join(final, "Champions")).then(async (count) => count + (await countBackups(path.join(final, "Maps", "Shipping")))),
    hasAnyFile(path.join(final, "Localized"), (name) => name.endsWith(`.wad.client${BAK_SUFFIX}`))
  ]);
  const voiceActive = voiceBackups > 0;
  return {
    ok: true,
    message: options.message ?? `游戏文件目录：${final}`,
    voice: voiceActive ? (display ? `【已切换为：${display}原声】` : "【已切换为：语音包原声】") : "【当前为：国服中文原版】",
    lang: langBackup ? (display ? `【已切换为：${display}语言】` : "【已切换为：语音包语言】") : "【当前为：国服中文原版】",
    is_voice_active: voiceActive,
    is_lang_active: langBackup,
    active_locale: activeLocale,
    final_dir: final,
    source: options.source ?? "",
    voice_backups: voiceBackups,
    lang_backup: langBackup
  };
}

async function readActiveLocale(voiceRoot: string, fallback: string): Promise<string> {
  const { readJsonFile } = await import("../core/fsx.ts");
  const data = await readJsonFile<{ locale?: string }>(path.join(voiceRoot, "active_locale.json"));
  return data?.locale ?? fallback;
}

export interface SpaceEstimate {
  ok: boolean;
  needed: number;
  free: number;
  requires_copy: boolean;
  backup_bytes: number;
  temp_bytes: number;
  detail: string;
  message: string;
}

/** 启动前估算额外磁盘空间(备份 + 必须复制进游戏盘的临时文件峰值)。 */
export async function estimateSpaceRequirement(options: {
  modules: ModuleId[];
  locale: string;
  voiceRoot: string;
  finalDir: string | null;
  /** 目标槽位后缀(默认国服 .zh_CN.wad.client)。 */
  baseSuffix?: string;
}): Promise<SpaceEstimate> {
  const result: SpaceEstimate = {
    ok: true,
    needed: 0,
    free: 0,
    requires_copy: false,
    backup_bytes: 0,
    temp_bytes: 0,
    detail: "",
    message: ""
  };
  if (!options.finalDir || !(await isDirectory(options.finalDir))) return result;
  const final = options.finalDir;

  const championsDir = path.join(final, "Champions");
  const linkable = await supportsHardlinks((await isDirectory(championsDir)) ? championsDir : final);

  let backupBytes = 0;
  let tempBytes = 0;

  const baseSuffix = options.baseSuffix || CN_WAD_SUFFIX;
  const measure = async (sources: string[], destDir: string) => {
    if (!sources.length) return;
    if (!linkable) {
      for (const src of sources) {
        const dst = path.join(destDir, `${wadStemOf(src)}${baseSuffix}`);
        if ((await isFile(dst)) && !(await isFile(backupPath(dst)))) {
          backupBytes += await fileSize(dst);
        }
      }
    }
    let peak = 0;
    let peakSrc: string | null = null;
    for (const src of sources) {
      const size = await fileSize(src);
      if (size > peak) {
        peak = size;
        peakSrc = src;
      }
    }
    if (await candidateNeedsCopy(peakSrc, destDir)) tempBytes = Math.max(tempBytes, peak);
  };

  if (options.modules.includes("ingame_voice")) {
    for (const group of await voiceGroups(options.locale, options.voiceRoot, final)) {
      await measure(group.sources, group.destDir);
    }
  }
  if (options.modules.includes("ingame_lang")) {
    const sources = await langSources(options.locale, options.voiceRoot);
    await measure(sources, path.join(final, "Localized"));
  }

  const needed = backupBytes + tempBytes;
  const free = await freeSpaceBytes(final);
  const parts: string[] = [];
  if (backupBytes) parts.push(`原版备份 ${humanBytes(backupBytes)}（目标盘不支持硬链接）`);
  if (tempBytes) parts.push(`临时资源文件 ${humanBytes(tempBytes)}（语言包与游戏盘不同盘或目标盘不支持硬链接）`);
  const detail = parts.length ? parts.join("；") : "无需额外空间（硬链接可用）";

  result.backup_bytes = backupBytes;
  result.temp_bytes = tempBytes;
  result.needed = needed;
  result.free = free;
  result.requires_copy = needed > 0;
  result.detail = detail;

  const margin = 256 * 1024 * 1024;
  if (needed && free && needed + margin > free) {
    result.ok = false;
    result.message = `磁盘空间不足：切换需要约 ${humanBytes(needed)} 额外空间（${detail}），当前剩余 ${humanBytes(free)}。请清理空间后重试。`;
  } else if (needed) {
    result.message = `需要复制文件（${detail}；目标盘剩余 ${humanBytes(free)}）`;
  }
  return result;
}

function wadStemOf(file: string): string {
  const name = path.basename(file);
  const withoutExt = name.endsWith(".wad.client") ? name.slice(0, -".wad.client".length) : name;
  return withoutExt.split(".")[0] ?? withoutExt;
}

/** 目标目录里需要被替换的槽位数量(资源缺失时显示 0/N)。suffix 为空则统计所有语种槽位。 */
export async function destSlotCount(directory: string, suffix = ""): Promise<number> {
  const explicit = await targetSlotCount(directory, suffix || CN_WAD_SUFFIX);
  if (explicit) return explicit;
  return targetSlotCount(directory);
}

/** 组装"资源缺失"的模块结果(供 apply/restore 复用)。 */
export function missingResult(module: ModuleId, check: ResourceCheck, action: "apply" | "restore" = "apply"): ModuleResult {
  return makeResult(module, false, {
    action,
    planned: check.planned,
    success: 0,
    failed: check.planned,
    missing: true,
    reason: check.reason || "资源缺失",
    message: check.message
  });
}
