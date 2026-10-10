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
import { ensureDir, isDirectory, isFile, listNames, removeQuietly, pathExists } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";
import { run } from "../core/win/shell.ts";
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

/** 解压压缩包到目标目录。zip/tar 用系统自带工具, 7z/rar 需要本机 7-Zip 或 WinRAR。 */
export async function extractArchive(archive: string, destDir: string, onLog?: (line: string) => void): Promise<ExtractResult> {
  await ensureDir(destDir);
  const lower = archive.toLowerCase();

  if (lower.endsWith(".zip") || lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    // 1) 系统自带 bsdtar(Win10+): 同时认 zip 与 tar
    const tar = await run("tar", ["-xf", archive, "-C", destDir], { timeoutMs: 0 });
    if (tar.ok) return { ok: true, tool: "tar", message: "解压完成" };
    onLog?.(tar.error ? `tar 解压失败: ${tar.error}，尝试 PowerShell` : "tar 解压返回非零，尝试 PowerShell");

    // 2) 退回 PowerShell 的 Expand-Archive(仅 zip)
    if (lower.endsWith(".zip")) {
      const script = `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
      const { runPowerShell } = await import("../core/win/shell.ts");
      const powershell = await runPowerShell(script, { timeoutMs: 0 });
      if (powershell.ok) return { ok: true, tool: "Expand-Archive", message: "解压完成" };
      return { ok: false, tool: "Expand-Archive", message: `解压失败: ${powershell.error || powershell.stderr.slice(0, 200)}` };
    }
    return { ok: false, tool: "tar", message: `解压失败: ${tar.error || tar.stderr.slice(0, 200)}` };
  }

  if (lower.endsWith(".7z") || lower.endsWith(".rar")) {
    const tool = await firstExisting(sevenZipCandidates());
    if (!tool) {
      const kind = lower.endsWith(".rar") ? "RAR" : "7z";
      return {
        ok: false,
        tool: "7z",
        message:
          `解压 ${kind} 需要本机安装 7-Zip 或 WinRAR（未找到）。\n` +
          `请安装后重试，或先把压缩包解压，再把其中的语种目录（含 DATA\\FINAL）手动放进资源目录。`
      };
    }
    const isUnrar = /unrar\.exe$/i.test(tool);
    const args = isUnrar
      ? ["x", "-y", archive, `${destDir}\\`]
      : ["x", "-y", `-o${destDir}`, archive];
    const result = await run(tool, args, { timeoutMs: 0 });
    if (result.ok) return { ok: true, tool: path.basename(tool), message: "解压完成" };
    return { ok: false, tool: path.basename(tool), message: `解压失败: ${result.error || result.stderr.slice(0, 200)}` };
  }

  return { ok: false, tool: "", message: `不支持的压缩包格式：${path.basename(archive)}（支持 zip / 7z / rar / tar / tar.gz）` };
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
  const match = /([a-z]{2})_([A-Za-z]{2})/.exec(text);
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
  if (!(await isDirectory(dir))) return 0;
  let count = 0;
  const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  while (queue.length) {
    const current = queue.shift()!;
    for (const name of await listNames(current.dir)) {
      const full = path.join(current.dir, name);
      if (await isDirectory(full)) {
        if (recursive && current.depth < 3) queue.push({ dir: full, depth: current.depth + 1 });
        continue;
      }
      if (match(name)) count += 1;
    }
  }
  return count;
}

/** 在解压结果里找出真正的语音包根目录。 */
export async function findPackLayout(extractedRoot: string): Promise<PackLayout | null> {
  const candidates: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: extractedRoot, depth: 0 }];
  while (queue.length) {
    const current = queue.shift()!;
    candidates.push(current.dir);
    if (current.depth >= 3) continue;
    for (const name of await listNames(current.dir)) {
      const full = path.join(current.dir, name);
      if (await isDirectory(full)) queue.push({ dir: full, depth: current.depth + 1 });
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
  /** 用户/前端显式指定的语种。 */
  locale?: string;
  /** 资源根目录。 */
  voiceRoot: string;
  /** 已存在同语种目录时是否覆盖(旧目录会被改名保留, 不会直接删)。 */
  overwrite?: boolean;
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
  const archiveName = path.basename(options.archive);
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

  if (!(await isFile(options.archive))) {
    return { ...empty, message: `压缩包不存在：${options.archive}` };
  }
  if (!(await ensureDir(options.voiceRoot))) {
    return { ...empty, message: `资源目录不可用：${options.voiceRoot}` };
  }

  // 临时目录放在资源目录内(同卷), 安装时改名即可, 不额外拷贝几个 GB
  const staging = path.join(options.voiceRoot, `.importing_${Date.now()}`);
  await ensureDir(staging);
  const extracted = path.join(staging, "extracted");
  try {
    progress("正在解压…", 5);
    log(`解压 ${archiveName} …`);
    const extract = await extractArchive(options.archive, extracted, log);
    if (!extract.ok) return { ...empty, message: extract.message };
    log(`解压完成（工具：${extract.tool}）`);

    progress("正在识别语音包结构…", 55);
    const layout = await findPackLayout(extracted);
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
    const target = path.join(options.voiceRoot, code);
    log(`识别语种：${code}（${guess.detail}）`);

    progress("正在安装到资源目录…", 75);
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
      const retired = `${target}.chosen_old_${Date.now()}`;
      try {
        await fs.rename(target, retired);
        log(`已存在同语种目录，旧目录保留为 ${path.basename(retired)}`);
      } catch (error) {
        return { ...empty, code, name, locale_source: guess.source, target, message: `覆盖失败：旧目录无法改名（${String((error as Error).message ?? error)}）` };
      }
    }

    // 同卷改名优先, 跨卷退回递归复制
    try {
      await fs.rename(layout.root, target);
    } catch {
      await copyTree(layout.root, target);
    }

    // 校验安装结果
    const installedChampions = await countIn(path.join(target, "DATA", "FINAL", "Champions"), (file) => file.endsWith(".wad.client"));
    const installedLobby = await countIn(path.join(target, "assets", "champion-choose-vo"), (file) => file.endsWith(".ogg"));
    const installed = installedChampions + installedLobby > 0;
    progress("完成", 100);

    if (!installed) {
      return {
        ...empty,
        code,
        name,
        locale_source: guess.source,
        target,
        message: `安装后校验失败：${target} 里没有可用的语音资源。`
      };
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
    return { ...empty, message: `导入失败：${String((error as Error).message ?? error)}` };
  } finally {
    // 只清临时目录(已安装的目标不在其中)
    await removeQuietly(staging);
  }
}

async function copyTree(from: string, to: string): Promise<void> {
  await ensureDir(to);
  for (const name of await listNames(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    const stat = await fs.stat(src).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) await copyTree(src, dst);
    else {
      await ensureDir(path.dirname(dst));
      await fs.copyFile(src, dst);
    }
  }
}

export { isLocaleCode };
