/**
 * 客户端自带资源包(WAD)的定位、解析与补丁。
 *
 * 格式(以 LeagueClient\\Plugins\\rcp-be-lol-game-data\\zh_CN-assets.wad 实测确认):
 *   0..3      magic "RW" + 版本(3.4)
 *   4..259    256 字节签名块(实测数据, 本模块不改动它)
 *   260..267  8 字节校验/摘要(同上, 不改动)
 *   268..271  条目数 u32
 *   272..     TOC: 每条 32 字节;  [+0]=?, [+4]=?, [+8]=数据偏移, [+12]=大小, [+16]=大小(重复), [+20]=0, [+24]=路径哈希(u64)
 *   TOC 之后为数据区, 条目按偏移指向各自数据。
 *
 * 补丁策略: **只追加、只改这两条记录里的偏移与大小** —— 不动签名块、条目顺序与条目数,
 * 因此补丁后文件结构与原文件逐字节兼容, 只是被替换的条目指向新追加的数据。
 *
 * 条目与具体资源的对应关系: 路径哈希算法未公开, 因此用**内容指纹**建立映射
 * (拿已知路径的原文件与之比对), 不依赖哈希算法。
 */
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import path from "node:path";
import { isDirectory, isFile, listNames, removeQuietly } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";

const logger = createLogger("wadfile");

export const GAME_DATA_PLUGIN = "rcp-be-lol-game-data";
export const WAD_MAGIC = "RW";
export const HEADER_SIZE = 268;
export const COUNT_OFFSET = 268;
export const TOC_OFFSET = 272;
export const ENTRY_SIZE = 32;

export const FIELD_OFFSET = 8;
export const FIELD_SIZE = 12;
export const FIELD_SIZE2 = 16;
/** [+24] 是客户端校验用的内容校验值(算法未公开, 只能原样搬运)。 */
export const FIELD_CHECKSUM = 24;
/**
 * 资源包里的条目可能是 zstd 压缩的(Game\DATA\FINAL 下的大包几乎全是)。
 * 判断依据就是 zstd 帧魔数, 不需要额外标记。
 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function isZstdFrame(data: Buffer): boolean {
  return data.length >= 4 && data.subarray(0, 4).equals(ZSTD_MAGIC);
}

/** 条目是不是"压缩后"的(按魔数判断, 不信任 TOC 里的大小字段)。 */
export function isCompressedEntry(data: Buffer): boolean {
  return isZstdFrame(data);
}

/** 解压单个条目; 不是压缩的就原样返回, 调用方不用判断。 */
export function decompressEntry(data: Buffer): Buffer {
  if (!isZstdFrame(data)) return data;
  return zlib.zstdDecompressSync(data) as Buffer;
}

/** 把数据压成 zstd 帧(补丁写回压缩条目时必须用)。 */
export function compressEntry(data: Buffer, level = 19): Buffer {
  return zlib.zstdCompressSync(data, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } }) as Buffer;
}

/** 兼容旧名(早期误以为它是路径哈希, 实测为内容校验值)。 */
export const FIELD_HASH = FIELD_CHECKSUM;

/** 追加数据时的对齐(实测原文件条目偏移均为 16 字节对齐)。 */
export const APPEND_ALIGN = 16;

export interface WadEntry {
  index: number;
  offset: number;
  size: number;
  size2: number;
  /** 字段 [+24]: 客户端用来校验本条目数据的内容校验值。 */
  hash: bigint;
}

export interface WadFile {
  path: string;
  version: string;
  count: number;
  dataStart: number;
  entries: WadEntry[];
  buffer: Buffer;
}

export interface WadLocation {
  ok: boolean;
  path: string | null;
  pluginDir: string | null;
  message: string;
}

function pluginDirCandidates(clientDir: string): string[] {
  return [
    path.join(clientDir, "Plugins", GAME_DATA_PLUGIN),
    path.join(clientDir, "LeagueClient", "Plugins", GAME_DATA_PLUGIN)
  ];
}

/** 定位客户端当前语种对应的资源包(客户端按 description.json 的 perLocaleAssetBundles 加载)。 */
export async function locateClientAssetWad(clientDir: string | null, locale: string): Promise<WadLocation> {
  if (!clientDir) return { ok: false, path: null, pluginDir: null, message: "未定位到联盟客户端目录" };
  for (const pluginDir of pluginDirCandidates(clientDir)) {
    if (!(await isDirectory(pluginDir))) continue;
    const exact = path.join(pluginDir, `${locale}-assets.wad`);
    if (await isFile(exact)) return { ok: true, path: exact, pluginDir, message: "已定位资源包" };
    const fallback = (await listNames(pluginDir)).find((name) => /^[a-z]{2}_[A-Z]{2}-assets\.wad$/.test(name));
    if (fallback) {
      return {
        ok: true,
        path: path.join(pluginDir, fallback),
        pluginDir,
        message: `未找到 ${locale}-assets.wad，回退到 ${fallback}`
      };
    }
    return { ok: false, path: null, pluginDir, message: `插件目录里没有语种资源包：${pluginDir}` };
  }
  return {
    ok: false,
    path: null,
    pluginDir: null,
    message: `未找到客户端资源插件目录：${pluginDirCandidates(clientDir).join(" 或 ")}`
  };
}

/* ------------------------------------------------------------------ 解析 */

export async function readWad(file: string): Promise<WadFile> {
  const buffer = await fs.readFile(file);
  if (buffer.length < HEADER_SIZE || buffer.subarray(0, 2).toString("ascii") !== WAD_MAGIC) {
    throw new Error(`不是有效的 RW WAD 文件：${file}`);
  }
  const version = `${buffer[2]}.${buffer[3]}`;
  const count = buffer.readUInt32LE(COUNT_OFFSET);
  const tocEnd = TOC_OFFSET + count * ENTRY_SIZE;
  if (count <= 0 || tocEnd > buffer.length) {
    throw new Error(`WAD 条目数异常(${count})：${file}`);
  }
  const entries: WadEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = TOC_OFFSET + i * ENTRY_SIZE;
    entries.push({
      index: i,
      offset: buffer.readUInt32LE(base + FIELD_OFFSET),
      size: buffer.readUInt32LE(base + FIELD_SIZE),
      size2: buffer.readUInt32LE(base + FIELD_SIZE2),
      hash: buffer.readBigUInt64LE(base + FIELD_HASH)
    });
  }
  return { path: file, version, count, dataStart: tocEnd, entries, buffer };
}

/** 只读 TOC(不加载整个文件, 用于超大 wad 的快速探查)。 */
export interface WadToc {
  path: string;
  version: string;
  count: number;
  dataStart: number;
  entries: WadEntry[];
}

export async function readWadEntries(file: string): Promise<WadToc> {
  const handle = await fs.open(file, "r");
  try {
    // 先读固定头部拿到条目数, 再按真实大小读 TOC(大 wad 的 TOC 可能远大于固定窗口)
    const head = Buffer.alloc(TOC_OFFSET);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const header = head.subarray(0, bytesRead);
    if (header.length < HEADER_SIZE || header.subarray(0, 2).toString("ascii") !== WAD_MAGIC) {
      throw new Error(`不是有效的 RW WAD 文件：${file}`);
    }
    const count = header.readUInt32LE(COUNT_OFFSET);
    const tocSize = count * ENTRY_SIZE;
    const toc = Buffer.alloc(tocSize);
    const read = await handle.read(toc, 0, tocSize, TOC_OFFSET);
    const buffer = Buffer.concat([header, toc.subarray(0, read.bytesRead)]);
    const entries: WadEntry[] = [];
    for (let i = 0; i < count; i += 1) {
      const base = TOC_OFFSET + i * ENTRY_SIZE;
      if (base + ENTRY_SIZE > buffer.length) break;
      // 注意: buffer 是 header + toc 拼接, 索引天然对齐
      entries.push({
        index: i,
        offset: buffer.readUInt32LE(base + FIELD_OFFSET),
        size: buffer.readUInt32LE(base + FIELD_SIZE),
        size2: buffer.readUInt32LE(base + FIELD_SIZE2),
        hash: buffer.readBigUInt64LE(base + FIELD_HASH)
      });
    }
    return { path: file, version: `${buffer[2]}.${buffer[3]}`, count, dataStart: TOC_OFFSET + count * ENTRY_SIZE, entries };
  } finally {
    await handle.close();
  }
}

/**
 * 按需读取某个条目的字节(不把整个资源包读进内存)。
 * 传 handle 可以复用同一个文件句柄连续读多条(建指纹索引时用得上)。
 */
export async function readEntryBytes(
  file: string,
  entry: WadEntry,
  bytes: number,
  handle?: import("node:fs/promises").FileHandle
): Promise<Buffer> {
  const want = Math.max(0, Math.min(bytes, entry.size));
  const own = handle ?? (await fs.open(file, "r"));
  try {
    const out = Buffer.alloc(want);
    const { bytesRead } = await own.read(out, 0, want, entry.offset);
    return out.subarray(0, bytesRead);
  } finally {
    if (!handle) await own.close();
  }
}

/**
 * 流式建立 "内容指纹 -> 条目序号" 索引: 每个条目只读前 N 字节。
 * 与 buildFingerprintIndex 结果等价, 但内存占用与资源包大小无关
 * (大资源包几百 MB 时, 整读版本会让进程常驻几百 MB)。
 */
export async function buildFingerprintIndexFromFile(
  file: string,
  entries: WadEntry[],
  bytes = 64
): Promise<Map<string, number[]>> {
  const index = new Map<string, number[]>();
  const handle = await fs.open(file, "r");
  try {
    for (const entry of entries) {
      const head = await readEntryBytes(file, entry, bytes, handle);
      if (!head.length) continue;
      const key = head.toString("hex");
      const list = index.get(key);
      if (list) list.push(entry.index);
      else index.set(key, [entry.index]);
    }
  } finally {
    await handle.close();
  }
  return index;
}

/** 条目数据的前 N 字节(用于内容指纹)。 */
export function entryFingerprint(wad: WadFile, index: number, bytes = 64): string {
  const entry = wad.entries[index];
  if (!entry) return "";
  const end = Math.min(entry.offset + bytes, entry.offset + entry.size, wad.buffer.length);
  return wad.buffer.subarray(entry.offset, end).toString("hex");
}

/** 建立 "内容指纹 -> 条目序号" 索引。 */
export function buildFingerprintIndex(wad: WadFile, bytes = 64): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const entry of wad.entries) {
    const key = entryFingerprint(wad, entry.index, bytes);
    if (!key) continue;
    const list = index.get(key);
    if (list) list.push(entry.index);
    else index.set(key, [entry.index]);
  }
  return index;
}

/** 按魔数统计条目类型(诊断用)。 */
export function summarizeMagic(wad: WadFile): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const entry of wad.entries) {
    const magic = wad.buffer.subarray(entry.offset, entry.offset + 4).toString("latin1").replace(/[^\x20-\x7E]/g, ".");
    stats[magic] = (stats[magic] ?? 0) + 1;
  }
  return stats;
}

/* ------------------------------------------------------------------ 补丁 */

export interface PatchItem {
  index: number;
  data: Buffer;
  label?: string;
  /**
   * 该条目的内容校验值(wad 的 [+24] 字段)。
   * 客户端会校验它 —— 自己算不出来(算法未公开), 所以只有从**官方同源 wad**
   * 搬运"数据 + 校验值"这一对时才会提供; 不提供则保持原值不动。
   */
  checksum?: bigint;
  /**
   * 数据是压缩帧时, 这里填**解压后**的字节数。
   * wad 的 [+12] 存压缩后大小、[+16] 存解压后大小; 不填则两个字段都写 data.length
   * (即"未压缩条目", 语音包一直走的就是这条路)。
   */
  uncompressedSize?: number;
}

export interface PatchResult {
  ok: boolean;
  patched: number;
  skipped: number;
  backup: string | null;
  bytesAppended: number;
  message: string;
  labels: string[];
  skippedLabels: string[];
}

export function backupPathFor(wadFile: string): string {
  return `${wadFile}.chosen_bak`;
}

/** 是否已被打过补丁(备份存在即视为可还原)。 */
export async function isWadPatched(wadFile: string): Promise<boolean> {
  return isFile(backupPathFor(wadFile));
}

/** 读出某个条目的内容, 压缩的自动解开(字体、贴图等都在压缩条目里)。 */
export async function readEntryContent(file: string, entry: WadEntry): Promise<Buffer> {
  const raw = await readEntryBytes(file, entry, entry.size);
  return decompressEntry(raw);
}

/**
 * 把若干条目的数据替换掉:
 *   1. 首次补丁前先把原文件整体备份为 <wad>.chosen_bak(只备份一次, 永不覆盖);
 *   2. 新数据按 16 字节对齐追加到文件末尾;
 *   3. 只更新对应条目的偏移与大小, 其余字节(含签名块)一律不动;
 *   4. 先写 <wad>.chosen_new 再原子改名, 中途失败不会破坏原文件。
 */
export async function patchWadEntries(wadFile: string, items: PatchItem[]): Promise<PatchResult> {
  const result: PatchResult = {
    ok: false,
    patched: 0,
    skipped: 0,
    backup: null,
    bytesAppended: 0,
    message: "",
    labels: [],
    skippedLabels: []
  };
  if (!items.length) return { ...result, ok: true, message: "没有需要替换的条目" };

  // 只读目录(几万个条目也就几百 KB), 整个资源包不读进内存
  const toc = await readWadEntries(wadFile);
  const originalSize = (await fs.stat(wadFile)).size;
  const tempFile = `${wadFile}.chosen_new`;
  const backup = backupPathFor(wadFile);

  // 1) 备份(仅首次)
  let createdBackup = false;
  if (!(await isFile(backup))) {
    try {
      await fs.copyFile(wadFile, backup);
      createdBackup = true;
    } catch (error) {
      return { ...result, message: `备份原资源包失败：${String((error as Error).message ?? error)}` };
    }
  }
  result.backup = backup;

  // 2) 追加数据 + 更新 TOC
  const chunks: Buffer[] = [];
  // 只记录"哪一小段目录要被改写成什么", 落地时按偏移写回去
  const tocEdits: { at: number; buf: Buffer }[] = [];
  let cursor = originalSize;
  const padding = (APPEND_ALIGN - (cursor % APPEND_ALIGN)) % APPEND_ALIGN;
  if (padding) {
    chunks.push(Buffer.alloc(padding));
    cursor += padding;
  }
  for (const item of items) {
    const entry = toc.entries[item.index];
    if (!entry || item.data.length === 0) {
      result.skipped += 1;
      if (item.label) result.skippedLabels.push(item.label);
      continue;
    }
    if (item.data.length > 0xffffffff) {
      result.skipped += 1;
      if (item.label) result.skippedLabels.push(item.label);
      continue;
    }
    chunks.push(item.data);
    // 24 字节 = [+8]偏移 +[12]大小 +[16]大小(重复) +[24]校验值;
    // 先按原值填好(+20 那 4 字节不动), 再覆盖需要改的字段 —— 与老实现逐字节等价
    const record = Buffer.alloc(24);
    record.writeUInt32LE(entry.offset, 0);
    record.writeUInt32LE(entry.size, 4);
    record.writeUInt32LE(entry.size2, 8);
    record.writeBigUInt64LE(entry.hash, 16);
    record.writeUInt32LE(cursor, 0);
    record.writeUInt32LE(item.data.length, 4);
    record.writeUInt32LE(item.uncompressedSize ?? item.data.length, 8);
    if (item.checksum !== undefined) record.writeBigUInt64LE(item.checksum, 16);
    tocEdits.push({ at: TOC_OFFSET + item.index * ENTRY_SIZE + FIELD_OFFSET, buf: record });
    cursor += item.data.length;
    const pad = (APPEND_ALIGN - (cursor % APPEND_ALIGN)) % APPEND_ALIGN;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      cursor += pad;
    }
    result.patched += 1;
    if (item.label) result.labels.push(item.label);
  }

  if (!result.patched) {
    if (createdBackup) await removeQuietly(backup);
    return { ...result, backup: createdBackup ? null : backup, message: "没有任何条目被替换" };
  }

  result.bytesAppended = cursor - originalSize;

  // 3) 流式落地: 原文件由内核整份拷贝(不占 JS 堆) -> 追加新数据 -> 只改目录那一小段 -> 原子改名
  //    对比老实现(readFile 整读 + Buffer.concat 再造一份 + writeFile):
  //    100 MB 的资源包峰值从"约 200 MB"降到"目录 + 新增数据", 通常几 MB 以内。
  try {
    await pipeline(createReadStream(wadFile), createWriteStream(tempFile));
    if (chunks.length) {
      const appendHandle = await fs.open(tempFile, "a");
      try {
        for (const chunk of chunks) await appendHandle.write(chunk);
      } finally {
        await appendHandle.close();
      }
    }
    const handle = await fs.open(tempFile, "r+");
    try {
      for (const edit of tocEdits) await handle.write(edit.buf, 0, edit.buf.length, edit.at);
    } finally {
      await handle.close();
    }
    await fs.rename(tempFile, wadFile);
  } catch (error) {
    await removeQuietly(tempFile);
    if (createdBackup) await removeQuietly(backup);
    return { ...result, ok: false, message: `写入资源包失败：${String((error as Error).message ?? error)}（原文件未受影响）` };
  }

  logger.info(`已替换 ${result.patched} 个条目, 追加 ${result.bytesAppended} 字节 -> ${wadFile}`);
  return {
    ...result,
    ok: true,
    message: `已替换 ${result.patched} 个条目（追加 ${(result.bytesAppended / 1048576).toFixed(1)} MB）`
  };
}

/** 还原: 把备份整体写回。 */
export async function restoreWad(wadFile: string): Promise<{ ok: boolean; message: string }> {
  const backup = backupPathFor(wadFile);
  if (!(await isFile(backup))) return { ok: true, message: "没有备份，无需还原" };
  const tempFile = `${wadFile}.chosen_new`;
  try {
    await fs.copyFile(backup, tempFile);
    await fs.rename(tempFile, wadFile);
    await removeQuietly(backup);
    logger.info(`已还原资源包: ${wadFile}`);
    return { ok: true, message: "已还原客户端原始资源包" };
  } catch (error) {
    await removeQuietly(tempFile);
    return { ok: false, message: `还原失败：${String((error as Error).message ?? error)}（客户端可能正在运行）` };
  }
}
