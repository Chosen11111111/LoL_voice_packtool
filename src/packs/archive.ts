/**
 * 语音包压缩包导入。
 *
 * 用户的交互是"选一个压缩包 → 自动记录 → 出现在语音包下拉栏"，因此这里的职责是:
 *   1. 解压到资源目录内的临时目录(同卷, 安装时改名即可, 不额外拷贝几 GB);
 *   2. 识别压缩包内部结构(DATA/FINAL 还是 assets), 以及它是什么语种;
 *   3. 规范化安装成 <资源目录>/<语种>/DATA/FINAL/... , 装完即被 scanLocales 发现。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { ensureDir, isDirectory, isFile, listNames, pathExists, walkFiles } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";
import { runStreaming, encodePowerShell } from "../core/win/shell.ts";
import { isLocaleCode, LOCALE_NAMES } from "./locales.ts";

const logger = createLogger("archive");

export const SUPPORTED_EXTENSIONS = [".zip", ".7z", ".rar", ".tar", ".gz", ".tgz"];

export interface ArchiveProgress {
  (phase: string, percent: number): void;
}

/* ------------------------------------------------------------------ 解压 */

function sevenZipCandidates(): string[] {
  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return [
    process.env["SEVEN_ZIP"] ?? "",
    path.join(pf, "7-Zip", "7z.exe"),
    path.join(pf86, "7-Zip", "7z.exe"),
    path.join(pf, "WinRAR", "UnRAR.exe"),
    path.join(pf86, "WinRAR", "UnRAR.exe")
  ].filter(Boolean);
}

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

export interface ExtractResult {
  ok: boolean;
  tool: string;
  message: string;
}

/**
 * 解压压缩包到目标目录。
 *
 * **只依赖系统自带的东西**, 不要求用户装任何软件:
 *   - zip / tar / tar.gz / tgz: 系统自带的 tar.exe(Windows 10 1803+ 都有), 失败再退 PowerShell 的 Expand-Archive;
 *   - 7z / rar: 也先用系统自带的 tar 试(Windows 11 24H2 起自带的 libarchive 能读), 不行就给明确提示,
 *     让用户改用 zip, 或先把包解开后直接导入文件夹(目录导入完全不需要解压工具)。
 */
export async function extractArchive(archive: string, destDir: string, onLog?: (line: string) => void, signal?: AbortSignal): Promise<ExtractResult> {
  signal?.throwIfAborted();
  await ensureDir(destDir);
  const lower = archive.toLowerCase();
  const isZip = lower.endsWith(".zip");
  const isTarLike = lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
  const isPacked = lower.endsWith(".7z") || lower.endsWith(".rar");

  if (isZip || isTarLike || isPacked) {
    if (isPacked) {
      onLog?.("7z/rar 先交给系统自带的解压试试(Windows 11 24H2 起自带支持)…");
    }
    const tar = await runStreaming("tar", ["-xf", archive, "-C", destDir], { timeoutMs: 0, signal });
    signal?.throwIfAborted();
    if (tar.ok) return { ok: true, tool: "tar", message: "解压完成" };

    if (isZip) {
      onLog?.(tar.error ? `tar 解压失败: ${tar.error}，尝试 PowerShell` : "tar 解压返回非零，尝试 PowerShell");
      const script = `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
      const powershell = await runStreaming(process.env.LEAGUE_VOICE_POWERSHELL || "powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)], { timeoutMs: 0, signal });
      signal?.throwIfAborted();
      if (powershell.ok) return { ok: true, tool: "Expand-Archive", message: "解压完成" };
      return { ok: false, tool: "Expand-Archive", message: `解压失败: ${powershell.error || powershell.stderr.slice(0, 200)}` };
    }

    if (isPacked) {
      const kind = lower.endsWith(".rar") ? "RAR" : "7z";
      return {
        ok: false,
        tool: "tar",
        message:
          `这台电脑系统自带的解压读不了 ${kind} 包（新版 Windows 才行）。\n` +
          `两个办法任选: ①换成 zip 包; ②先用系统自带的方式把包解开, 再点"语音包选择"直接选那个文件夹（文件夹导入不需要任何解压工具）。`
      };
    }
    return { ok: false, tool: "tar", message: `解压失败: ${tar.error || tar.stderr.slice(0, 200)}` };
  }

  return { ok: false, tool: "", message: `不支持的压缩包格式：${path.basename(archive)}（支持 zip / tar / tar.gz / 7z / rar）` };
}

/* ------------------------------------------------------------------ 语种识别 */

const NAME_HINTS: Array<[RegExp, string]> = [
  [/japanese|nihongo|日语|日文|日服|jp\b/i, "ja_JP"],
  [/korean|한국|韩语|韩文|韩服|kr\b|ko\b/i, "ko_KR"],
  [/english|英语|英文|美服|us\b|en\b/i, "en_US"],
  [/chinese|simplified|简体|中文|国服|cn\b|zh\b/i, "zh_CN"],
  [/traditional|繁体|台服|tw\b/i, "zh_TW"]
];

function normalizeLocaleCode(raw: string): string | null {
  const text = raw.replace("-", "_");
  const match = /(?:^|[^A-Za-z])([a-z]{2})_([A-Za-z]{2})(?=$|[^A-Za-z])/.exec(text);
  if (!match) return null;
  const code = `${match[1]!.toLowerCase()}_${match[2]!.toUpperCase()}`;
  return isLocaleCode(code) ? code : code;
}

/** 从一个名字里猜语种(压缩包名 / 目录名 / 文件后缀)。 */
export function guessLocaleFromName(name: string): string | null {
  for (const [pattern, code] of NAME_HINTS) {
    if (pattern.test(name)) return code;
  }
  return normalizeLocaleCode(name);
}

const WAD_LOCALE = /\.([a-z]{2}_[A-Z]{2})\.wad\.client$/i;

/** 从解压出来的文件里统计语种后缀, 取最多的。 */
async function tallyLocales(root: string, depth = 0): Promise<Record<string, number>> {
  const tally: Record<string, number> = {};
  if (!(await isDirectory(root)) || depth > 4) return tally;
  for (const name of await listNames(root)) {
    const full = path.join(root, name);
    if (await isDirectory(full)) {
      const nested = await tallyLocales(full, depth + 1);
      for (const [code, count] of Object.entries(nested)) tally[code] = (tally[code] ?? 0) + count;
      continue;
    }
    const match = WAD_LOCALE.exec(name);
    if (match) {
      const code = `${match[1]!.slice(0, 2).toLowerCase()}_${match[1]!.slice(3).toUpperCase()}`;
      tally[code] = (tally[code] ?? 0) + 1;
    }
  }
  return tally;
}

export type LocaleSource = "explicit" | "archive-name" | "pack-name" | "file-suffix" | "fallback";

export interface LocaleGuess {
  code: string;
  source: LocaleSource;
  detail: string;
}

/* ------------------------------------------------------------------ 结构识别 */

export interface PackLayout {
  /** 包含 DATA 的那一层(要安装到 <资源目录>/<语种>/ 的内容)。 */
  root: string;
  finalDir: string | null;
  assetsDir: string | null;
  champions: number;
  maps: number;
  localized: number;
  lobby: number;
}

async function countIn(dir: string, match: (name: string) => boolean, recursive = false): Promise<number> {
  return (await walkFiles(dir, { match, recursive })).length;
}

/** 在解压结果里找出真正的语音包根目录。 */
export async function findPackLayout(extractedRoot: string): Promise<PackLayout | null> {
  const candidates: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: extractedRoot, depth: 0 }];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    candidates.push(current.dir);
    if (current.depth >= 3) continue;
    const entries = await fs.readdir(current.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }

  for (const dir of candidates) {
    const names = await listNames(dir);
    const lower = names.map((name) => name.toLowerCase());
    const hasData = lower.includes("data");
    const hasAssets = lower.includes("assets");
    const hasChampions = lower.includes("champions");
    const finalDir = hasData
      ? (await isDirectory(path.join(dir, "DATA", "FINAL")))
        ? path.join(dir, "DATA", "FINAL")
        : (await pathExists(path.join(dir, "Data", "Final")))
          ? path.join(dir, "Data", "Final")
          : null
      : hasChampions
        ? dir
        : null;
    if (!finalDir && !hasAssets) continue;

    const counts = {
      champions: finalDir ? await countIn(path.join(finalDir, "Champions"), (name) => name.endsWith(".wad.client")) : 0,
      maps: finalDir ? await countIn(path.join(finalDir, "Maps"), (name) => name.endsWith(".wad.client"), true) : 0,
      localized: finalDir ? await countIn(path.join(finalDir, "Localized"), (name) => name.endsWith(".wad.client")) : 0,
      lobby: hasAssets ? await countIn(path.join(dir, "assets", "champion-choose-vo"), (name) => name.endsWith(".ogg")) : 0
    };
    if (counts.champions + counts.maps + counts.localized + counts.lobby === 0) continue;
    return {
      root: dir,
      finalDir,
      assetsDir: hasAssets ? path.join(dir, "assets") : null,
      ...counts
    };
  }
  return null;
}

/* ------------------------------------------------------------------ 导入 */

export interface ImportOptions {
  /** 压缩包路径(上传后的临时文件, 或用户直接给的本地路径)。 */
  archive: string;
  /** 上传落盘时使用随机文件名，识别仍使用用户提供的原文件名。 */
  archiveName?: string;
  /** 用户/前端显式指定的语种。 */
  locale?: string;
  /** 资源根目录。 */
  voiceRoot: string;
  /** 已存在同语种目录时是否覆盖(旧目录会被改名保留, 不会直接删)。 */
  overwrite?: boolean;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
  onProgress?: ArchiveProgress;
}

export interface ImportResult {
  ok: boolean;
  code: string;
  name: string;
  message: string;
  locale_source: LocaleSource | "none";
  installed: boolean;
  target: string;
  stats: { champions: number; maps: number; localized: number; lobby: number };
}

/** 完整导入流程: 解压 -> 识别 -> 安装到资源目录。 */
export async function importArchive(options: ImportOptions): Promise<ImportResult> {
  const log = options.onLog ?? (() => undefined);
  const progress = options.onProgress ?? (() => undefined);
  const archiveName = path.basename(options.archiveName ?? options.archive);
  const empty: ImportResult = {
    ok: false,
    code: "",
    name: archiveName,
    message: "",
    locale_source: "none",
    installed: false,
    target: "",
    stats: { champions: 0, maps: 0, localized: 0, lobby: 0 }
  };

  if (options.signal?.aborted) return { ...empty, message: "已取消导入" };
  const explicitLocale = (options.locale ?? "").trim();
  if (explicitLocale && !/^[\w\u4e00-\u9fa5-]+$/.test(explicitLocale)) {
    return { ...empty, message: "语种必须是单个目录名，不能包含路径分隔符或上级目录" };
  }
  const sourceIsDir = await isDirectory(options.archive);
  if (!sourceIsDir && !(await isFile(options.archive))) {
    return { ...empty, message: `找不到这个文件或文件夹：${options.archive}` };
  }
  if (!(await ensureDir(options.voiceRoot))) {
    return { ...empty, message: `资源目录不可用：${options.voiceRoot}` };
  }

  // 临时目录放在资源目录内(同卷), 安装时改名即可, 不额外拷贝几个 GB
  const resourceRoot = path.resolve(options.voiceRoot);
  const staging = await fs.mkdtemp(path.join(resourceRoot, ".importing_"));
  const extracted = path.join(staging, "extracted");
  let retired: string | null = null;
  let target = "";
  let published = false;
  try {
    if (sourceIsDir) {
      // 目录导入: 完全不用解压工具(适配任何系统), 也不经过浏览器上传。
      // 复制到暂存区而不是搬走 —— 源文件夹是用户自己的东西, 我们不动它。
      progress("正在读取文件夹…", 5);
      log(`从文件夹导入: ${options.archive}`);
      await fs.cp(options.archive, extracted, { recursive: true });
      log("已复制到暂存区，开始识别结构");
    } else {
      progress("正在解压…", 5);
      log(`解压 ${archiveName} …`);
      const extract = await extractArchive(options.archive, extracted, log, options.signal);
      if (!extract.ok) return { ...empty, message: extract.message };
      log(`解压完成（工具：${extract.tool}）`);
    }

    progress("正在识别语音包结构…", 55);
    const layout = await findPackLayout(extracted);
    options.signal?.throwIfAborted();
    if (!layout) {
      return {
        ...empty,
        message:
          "压缩包里没有找到语音包资源（需要 DATA\\FINAL\\Champions 之类的目录结构，或 assets\\champion-choose-vo）。\n" +
          "请确认压缩包内容是英雄联盟语音包。"
      };
    }
    log(`识别到资源：对局语音 ${layout.champions} 个 / 播报员 ${layout.maps} 个 / 文本 ${layout.localized} 个 / 选人语音 ${layout.lobby} 个`);

    // 语种识别: 显式指定 > 压缩包名 > 包内目录名 > 文件后缀
    let guess: LocaleGuess | null = null;
    const explicit = (options.locale ?? "").trim();
    if (explicit) {
      guess = { code: explicit, source: "explicit", detail: "调用方指定" };
    } else {
      const fromArchive = guessLocaleFromName(archiveName);
      if (fromArchive) guess = { code: fromArchive, source: "archive-name", detail: `压缩包名 ${archiveName}` };
      if (!guess) {
        const packName = path.basename(layout.root);
        const fromPack = guessLocaleFromName(packName);
        if (fromPack) guess = { code: fromPack, source: "pack-name", detail: `包内目录 ${packName}` };
      }
      if (!guess) {
        const tally = Object.entries(await tallyLocales(layout.finalDir ?? layout.root)).sort((a, b) => b[1] - a[1]);
        const best = tally[0];
        if (best && best[1] > 0) guess = { code: best[0], source: "file-suffix", detail: `文件后缀 ${best[0]}（${best[1]} 个）` };
      }
      if (!guess) {
        const fallback = archiveName.replace(/\.[^.]+$/, "").replace(/[^\w\u4e00-\u9fa5-]+/g, "_") || "custom_pack";
        guess = { code: fallback, source: "fallback", detail: "无法识别，用压缩包名" };
      }
    }

    const code = guess.code;
    const name = LOCALE_NAMES[code] ?? `${code}`;
    target = path.join(resourceRoot, code);
    log(`识别语种：${code}（${guess.detail}）`);

    progress("正在安装到资源目录…", 75);
    options.signal?.throwIfAborted();
    if (layout.root === layout.finalDir) {
      const normalized = path.join(staging, "normalized");
      await fs.mkdir(path.join(normalized, "DATA"), { recursive: true });
      await fs.rename(layout.root, path.join(normalized, "DATA", "FINAL"));
      layout.root = normalized;
    }
    if (await pathExists(target)) {
      if (!options.overwrite) {
        return {
          ...empty,
          code,
          name,
          locale_source: guess.source,
          target,
          message: `资源目录里已经存在 ${code} 了（${target}）。\n如需替换请选择覆盖，旧目录会被改名保留而不会被删除。`
        };
      }
      const old = `${target}.chosen_old_${path.basename(staging)}`;
      try {
        await fs.rename(target, old);
        retired = old;
      } catch (error) {
        return { ...empty, code, name, locale_source: guess.source, target, message: `覆盖失败：旧目录无法改名（${String((error as Error).message ?? error)}）` };
      }
      log(`已存在同语种目录，旧目录保留为 ${path.basename(old)}`);
    }

    // 解压目录与资源目录同卷，原子发布；失败时恢复旧目录。
    options.signal?.throwIfAborted();
    await fs.rename(layout.root, target);
    published = true;

    // 校验安装结果
    const installedChampions = await countIn(path.join(target, "DATA", "FINAL", "Champions"), (file) => file.endsWith(".wad.client"));
    const installedLobby = await countIn(path.join(target, "assets", "champion-choose-vo"), (file) => file.endsWith(".ogg"));
    const [installedMaps, installedLocalized] = await Promise.all([
      countIn(path.join(target, "DATA", "FINAL", "Maps"), (file) => file.endsWith(".wad.client"), true),
      countIn(path.join(target, "DATA", "FINAL", "Localized"), (file) => file.endsWith(".wad.client"))
    ]);
    const installed = installedChampions + installedLobby + installedMaps + installedLocalized > 0;
    options.signal?.throwIfAborted();
    progress("完成", 100);

    if (!installed) {
      throw new Error(`安装后校验失败：${target} 里没有可用的语音资源。`);
    }

    log(`已安装到 ${target}`);
    return {
      ok: true,
      code,
      name,
      message: `已导入语音包「${name}」（对局语音 ${installedChampions} 个 / 选人语音 ${installedLobby} 个）`,
      locale_source: guess.source,
      installed: true,
      target,
      stats: layout
    };
  } catch (error) {
    let recovery = "";
    try {
      if (published) await fs.rename(target, path.join(staging, "failed-install"));
      if (retired) await fs.rename(retired, target);
    } catch (restoreError) {
      recovery = `；旧目录恢复失败：${String((restoreError as Error).message ?? restoreError)}（保留在 ${retired ?? target}）`;
    }
    return { ...empty, message: (options.signal?.aborted ? "已取消导入" : `导入失败：${String((error as Error).message ?? error)}`) + recovery };
  } finally {
    // 只清临时目录(已安装的目标不在其中)
    const relative = path.relative(resourceRoot, staging);
    if (relative.startsWith(".importing_") && !relative.includes(path.sep) && !path.isAbsolute(relative)) {
      await fs.rm(staging, { recursive: true, force: true }).catch((error) => log(`临时目录清理失败：${String(error)}`));
    }
  }
}

export { isLocaleCode };
