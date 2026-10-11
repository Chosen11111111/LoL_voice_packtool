/**
 * 文件系统原语: 本工具的"安全替换"全部建立在这几个函数上。
 *
 * 铁律(与旧版 Python 工具一致, 不允许退化):
 * 1. 目标文件在替换成功之前始终存在 —— 备份只用硬链接或"先写 .part 再改名", 从不移动目标文件;
 * 2. 任何一步失败都回到调用前状态 —— 本次新建的备份/临时文件全部清掉,
 *    否则状态查询会把"没换成"误判成已开启;
 * 3. 资源文件只读不写。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BAK_SUFFIX, NEW_SUFFIX, PART_SUFFIX } from "../version.ts";
import { classifyError } from "./errors.ts";

export { BAK_SUFFIX, NEW_SUFFIX, PART_SUFFIX };

let probeCounter = 0;
function probeName(dir: string, tag: string): string {
  probeCounter += 1;
  return path.join(dir, `.league_voice_${tag}_${process.pid}_${probeCounter}`);
}

/* ------------------------------------------------------------------ 基础查询 */

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

export async function fileSize(target: string): Promise<number> {
  try {
    return (await fs.stat(target)).size;
  } catch {
    return 0;
  }
}

export async function ensureDir(dir: string): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export async function removeQuietly(target: string): Promise<boolean> {
  try {
    await fs.rm(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 读目录里的文件名(不含子目录), 出错返回空数组。 */
export async function listNames(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

export interface WalkOptions {
  recursive?: boolean;
  /** 只返回匹配的路径(入参为文件名)。 */
  match?: (name: string) => boolean;
  /** 命中一个就返回(用于 any(...) 语义, 避免大目录全量遍历)。 */
  firstOnly?: boolean;
}

/** 遍历目录里的文件(不跟随目录联接/symlink)。 */
export async function walkFiles(dir: string, options: WalkOptions = {}): Promise<string[]> {
  const { recursive = false, match, firstOnly = false } = options;
  const found: string[] = [];
  const queue: string[] = [dir];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let isDir = entry.isDirectory();
      let isFileEntry = entry.isFile();
      if (entry.isSymbolicLink()) {
        // 目录联接指向别处: 统计时当成"目录"跳过展开, 避免把外部内容算进来
        continue;
      }
      if (isDir) {
        if (recursive) queue.push(full);
        continue;
      }
      if (!isFileEntry) {
        try {
          isFileEntry = (await fs.stat(full)).isFile();
        } catch {
          isFileEntry = false;
        }
      }
      if (!isFileEntry) continue;
      if (match && !match(entry.name)) continue;
      found.push(full);
      if (firstOnly) return found;
    }
  }
  return found;
}

export async function hasAnyFile(dir: string, match: (name: string) => boolean, recursive = false): Promise<boolean> {
  const hit = await walkFiles(dir, { recursive, match, firstOnly: true });
  return hit.length > 0;
}

export async function countFiles(dir: string, match: (name: string) => boolean, recursive = false): Promise<number> {
  const all = await walkFiles(dir, { recursive, match });
  return all.length;
}

export async function readTextFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

export async function writeTextFile(file: string, text: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, text, "utf8");
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  const text = await readTextFile(file);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 原子写文件: 先写同目录临时文件再改名, 断电/中断不会留下半个 JSON。 */
const atomicWrites = new Map<string, Promise<void>>();

export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const resolved = path.resolve(file);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const writing = (atomicWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    await ensureDir(path.dirname(resolved));
    const temp = `${resolved}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(temp, data, { flag: "wx" });
      await fs.rename(temp, resolved);
    } finally {
      await removeQuietly(temp);
    }
  });
  atomicWrites.set(key, writing);
  try { await writing; }
  finally { if (atomicWrites.get(key) === writing) atomicWrites.delete(key); }
}

/* ------------------------------------------------------------------ 拷贝/硬链接 */

export async function tryHardlink(src: string, dst: string): Promise<boolean> {
  try {
    await fs.link(src, dst);
    return true;
  } catch {
    return false;
  }
}

/** 等价于 Python shutil.copy2: 复制内容并保留修改时间。 */
export async function copyFilePreserve(src: string, dst: string): Promise<void> {
  await fs.copyFile(src, dst);
  try {
    const st = await fs.stat(src);
    await fs.utimes(dst, st.atime, st.mtime);
  } catch {
    /* 时间戳保留失败不影响正确性 */
  }
}

/** 探测目录所在卷是否支持硬链接(决定是否需要预留整份备份空间)。 */
export async function supportsHardlinks(dir: string): Promise<boolean> {
  if (!(await ensureDir(dir))) return false;
  const probe = probeName(dir, "probe");
  const link = `${probe}.lnk`;
  try {
    await removeQuietly(probe);
    await removeQuietly(link);
    await fs.writeFile(probe, "x");
    await fs.link(probe, link);
    return true;
  } catch {
    return false;
  } finally {
    await removeQuietly(link);
    await removeQuietly(probe);
  }
}

/** 资源文件是否必须复制进目标目录(跨盘或目标盘不支持硬链接)。 */
export async function candidateNeedsCopy(sample: string | null, targetDir: string): Promise<boolean> {
  if (!sample) return false;
  if (!(await ensureDir(targetDir))) return true;
  const probe = probeName(targetDir, "link");
  try {
    await removeQuietly(probe);
    await fs.link(sample, probe);
    return false;
  } catch {
    return true;
  } finally {
    await removeQuietly(probe);
  }
}

/** 目标目录可写性探测(Windows 上 access 不可靠, 直接写探针文件)。 */
export async function dirWritable(dir: string): Promise<boolean> {
  if (!(await ensureDir(dir))) return false;
  const probe = probeName(dir, "write");
  try {
    await fs.writeFile(probe, "");
    await removeQuietly(probe);
    return true;
  } catch {
    return false;
  }
}

export async function targetDirState(dir: string): Promise<[boolean, string]> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    return [false, `目标目录不可用(${classifyError(error)})`];
  }
  if (!(await dirWritable(dir))) return [false, "目标目录不可写"];
  return [true, ""];
}

export async function freeSpaceBytes(target: string): Promise<number> {
  try {
    const stats = await fs.statfs(target);
    return Number(stats.bsize) * Number(stats.bavail);
  } catch {
    return 0;
  }
}

export function humanBytes(size: number): string {
  let value = Number(size) || 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i]!;
    if (value < 1024 || unit === "TB") {
      return unit === "B" ? `${Math.trunc(value)} B` : `${value.toFixed(2)} ${unit}`;
    }
    value /= 1024;
  }
  return `${value.toFixed(2)} TB`;
}

/* ------------------------------------------------------------------ 备份与替换 */

export function backupPath(dst: string): string {
  return `${dst}${BAK_SUFFIX}`;
}

export function tempPath(dst: string): string {
  return `${dst}${NEW_SUFFIX}`;
}

export function backupPartialPath(bak: string): string {
  return `${bak}${PART_SUFFIX}`;
}

/** 把新内容准备到目标目录(同卷)的临时文件里; 失败时目标文件完全不受影响。 */
export async function prepareCandidate(src: string, temp: string): Promise<[boolean, string]> {
  await removeQuietly(temp);
  if (await tryHardlink(src, temp)) return [true, ""];
  try {
    await copyFilePreserve(src, temp);
    return [true, ""];
  } catch (error) {
    await removeQuietly(temp);
    return [false, classifyError(error)];
  }
}

/**
 * 把国服原版备份到 .chosen_bak。
 * 硬链接可用就直接建链(零拷贝); 否则复制到 <bak>.part, 完整后再原子改名发布。
 * 复制途中被强杀只会留下 .part —— 状态查询与还原都只认正式备份名,
 * 不会把半份文件当成原版(否则"还原"会把残缺文件写回游戏)。
 */
export async function createBackup(dst: string, bak: string): Promise<[boolean, string]> {
  if (await tryHardlink(dst, bak)) return [true, ""];
  const partial = backupPartialPath(bak);
  await removeQuietly(partial);
  try {
    await copyFilePreserve(dst, partial);
  } catch (error) {
    const removed = await removeQuietly(partial);
    if (!removed) {
      return [false, `备份原文件失败(${classifyError(error)})；且未能清理未完成的备份 ${path.basename(partial)}（请手动删除，它不会被使用）`];
    }
    return [false, `备份原文件失败(${classifyError(error)})`];
  }
  try {
    await fs.rename(partial, bak);
  } catch (error) {
    await removeQuietly(partial);
    return [false, `备份原文件失败(发布未完成的备份时出错: ${classifyError(error)})`];
  }
  return [true, ""];
}

/** 替换单个文件: 先在目标目录准备好新文件, 再同目录原子替换。 */
export async function replaceFile(src: string, dst: string): Promise<[boolean, string]> {
  if (!(await isFile(src))) return [false, `资源文件不存在(${path.basename(src)})`];

  const bak = backupPath(dst);
  const temp = tempPath(dst);

  const [prepared, prepareReason] = await prepareCandidate(src, temp);
  if (!prepared) return [false, prepareReason];

  let createdBackup = false;
  if ((await pathExists(dst)) && !(await pathExists(bak))) {
    const [backed, why] = await createBackup(dst, bak);
    if (!backed) {
      await removeQuietly(temp);
      await removeQuietly(bak);
      return [false, why];
    }
    createdBackup = true;
  }

  try {
    await fs.rename(temp, dst);
  } catch (error) {
    await removeQuietly(temp);
    if (createdBackup && !(await removeQuietly(bak))) {
      return [false, `${classifyError(error)}；且未能清理备份 ${path.basename(bak)}（请手动删除，否则状态可能显示为已开启）`];
    }
    return [false, classifyError(error)];
  }
  return [true, ""];
}

/** 把备份还原回目标: 同目录原子改名, 失败时当前文件保持原样(绝不先删后写)。 */
export async function restoreFileVerbose(dst: string): Promise<[boolean, string]> {
  const bak = backupPath(dst);
  if (!(await pathExists(bak))) return [true, ""];
  try {
    await fs.rename(bak, dst);
    return [true, ""];
  } catch (error) {
    return [false, classifyError(error)];
  }
}

/** 清理复制中断留下的 <bak>.part(不是有效备份, 也不会被使用)。 */
export async function cleanPartialBackups(directory: string): Promise<number> {
  const partials = await walkFiles(directory, { match: (name) => name.endsWith(`${BAK_SUFFIX}${PART_SUFFIX}`) });
  let removed = 0;
  for (const partial of partials) {
    if (await removeQuietly(partial)) removed += 1;
  }
  return removed;
}

/** 目录里是否存在任意一份正式国服备份(状态判断只看这个)。 */
export async function hasBackup(directory: string): Promise<boolean> {
  const hit = await walkFiles(directory, { match: (name) => name.endsWith(`${BAK_SUFFIX}`), firstOnly: true });
  return hit.length > 0;
}

export async function countBackups(directory: string): Promise<number> {
  return walkFiles(directory, { match: (name) => name.endsWith(`${BAK_SUFFIX}`) }).then((all) => all.length);
}

/* ------------------------------------------------------------------ 目录联接 (junction) */

/** 创建目录联接: Node 原生 junction 无需管理员, 失败再退回 cmd mklink /J。 */
export async function createJunction(link: string, target: string): Promise<[boolean, string]> {
  await ensureDir(path.dirname(link));
  try {
    await fs.symlink(path.resolve(target), link, "junction");
    return [true, ""];
  } catch (error) {
    const fallback = await runMklink(link, target);
    if (fallback) return [true, ""];
    return [false, `创建目录联接失败(${classifyError(error)})`];
  }
}

async function runMklink(link: string, target: string): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn("cmd", ["/c", "mklink", "/J", link, target], { windowsHide: true });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/**
 * 判定路径是否为目录联接/符号链接。
 *
 * 注意(实测): Windows 上用 fs.symlink(..., "junction") 建出来的联接,
 * lstat() 会报成"普通目录"(isSymbolicLink=false, readlink 报 EINVAL),
 * 只靠 lstat 判断会导致"还原时删不掉挂载"这种隐性故障。
 * 因此再加一层 realpath 判定: 联接会被解析到目标路径, 真实目录解析回自身。
 */
export async function isJunction(link: string): Promise<boolean> {
  try {
    if ((await fs.lstat(link)).isSymbolicLink()) return true;
  } catch {
    return false;
  }
  try {
    const resolved = await fs.realpath(link);
    return normalizeForCompare(resolved) !== normalizeForCompare(link);
  } catch {
    return false;
  }
}

function normalizeForCompare(input: string): string {
  const text = path.resolve(input).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? text.toLowerCase() : text;
}

export async function isDirectoryEmpty(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).length === 0;
  } catch {
    return false;
  }
}

/**
 * 删除目录联接。只删真正的联接/符号链接 —— 万一目标位置被换成了真实目录,
 * 这里绝不递归删除(那会删掉用户数据), 而是返回 false 让调用方决定。
 */
export async function removeJunction(link: string): Promise<boolean> {
  if (!(await pathExists(link))) return true; // 不存在视为已清理
  if (!(await isJunction(link))) return false;
  try {
    await fs.rmdir(link);
    return true;
  } catch {
    /* 退回 cmd rmdir */
  }
  const { spawn } = await import("node:child_process");
  const ok = await new Promise<boolean>((resolve) => {
    try {
      const child = spawn("cmd", ["/c", "rmdir", link], { windowsHide: true });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
  return ok;
}

/** 删除空目录(失败返回 false, 绝不递归)。 */
export async function removeEmptyDir(dir: string): Promise<boolean> {
  try {
    await fs.rmdir(dir);
    return true;
  } catch {
    return false;
  }
}

/** 清理挂载点: 联接直接删; 残留的空目录也删掉(常见于上次中断留下的空壳); 非空目录不动。 */
export async function clearMountPoint(link: string): Promise<boolean> {
  if (!(await pathExists(link))) return true;
  if (await isJunction(link)) return removeJunction(link);
  if (await isDirectoryEmpty(link)) return removeEmptyDir(link);
  return false;
}
