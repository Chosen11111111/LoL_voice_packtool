/**
 * WAD 读写与补丁的自测。
 * 全部使用**内存里合成的 wad**, 绝不触碰任何真实客户端文件。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { cleanupSuite, makeTempDir, useSuite } from "./helpers.ts";
import {
  APPEND_ALIGN,
  ENTRY_SIZE,
  FIELD_CHECKSUM,
  FIELD_OFFSET,
  FIELD_SIZE,
  FIELD_SIZE2,
  TOC_OFFSET,
  backupPathFor,
  buildFingerprintIndex,
  buildFingerprintIndexFromFile,
  compressEntry,
  decompressEntry,
  isCompressedEntry,
  isZstdFrame,
  readEntryContent,
  entryFingerprint,
  isWadPatched,
  patchWadEntries,
  readEntryBytes,
  readWad,
  readWadEntries,
  restoreWad,
  summarizeMagic
} from "../src/packs/wadfile.ts";

useSuite("wadfile");

/** 按实测格式合成一个 RW 3.4 wad: 0..267 头 + 268 条目数 + TOC + 数据区。 */
function makeWad(entries: Buffer[]): Buffer {
  const header = Buffer.alloc(272);
  header.write("RW", 0, "ascii");
  header[2] = 3;
  header[3] = 4;
  header.writeUInt32LE(entries.length, 268);
  const toc = Buffer.alloc(entries.length * 32);
  let offset = 272 + entries.length * 32;
  const datas: Buffer[] = [];
  entries.forEach((data, i) => {
    const base = i * 32;
    toc.writeUInt32LE(offset, base + 8);
    toc.writeUInt32LE(data.length, base + 12);
    toc.writeUInt32LE(data.length, base + 16);
    toc.writeBigUInt64LE(BigInt("0x1234567") * BigInt(i + 1), base + 24);
    datas.push(data);
    offset += data.length;
  });
  return Buffer.concat([header, toc, ...datas]);
}

const OGG_A = Buffer.concat([Buffer.from("OggS"), Buffer.from("choose-vo-103".repeat(8))]);
const OGG_B = Buffer.concat([Buffer.from("OggS"), Buffer.from("ban-vo-103".repeat(9))]);
const PNG_C = Buffer.concat([Buffer.from(".PNG"), Buffer.from("icon".repeat(20))]);

async function writeWad(root: string, entries: Buffer[]): Promise<{ file: string; original: Buffer }> {
  const original = makeWad(entries);
  const file = path.join(root, "zh_CN-assets.wad");
  await fs.writeFile(file, original);
  return { file, original };
}

test("解析: 条目数/偏移/大小/哈希与合成时一致", async () => {
  const root = await makeTempDir("wad-read");
  const { file } = await writeWad(root, [OGG_A, OGG_B, PNG_C]);

  const wad = await readWad(file);
  assert.equal(wad.version, "3.4");
  assert.equal(wad.count, 3);
  assert.equal(wad.dataStart, 272 + 3 * 32);
  assert.deepEqual(wad.entries.map((e) => e.size), [OGG_A.length, OGG_B.length, PNG_C.length]);
  assert.equal(wad.entries[0]!.offset, wad.dataStart);
  assert.equal(wad.entries[1]!.offset, wad.dataStart + OGG_A.length);
  assert.equal(wad.entries[1]!.hash, 0x1234567n * 2n);

  const magic = summarizeMagic(wad);
  assert.equal(magic.OggS, 2);
  assert.equal(magic[".PNG"], 1);

  // 流式读取(不整文件加载)结果一致
  const streamed = await readWadEntries(file);
  assert.equal(streamed.count, 3);
  assert.deepEqual(streamed.entries.map((e) => e.offset), wad.entries.map((e) => e.offset));
});

test("内容指纹: 能按前 64 字节反查到条目序号", async () => {
  const root = await makeTempDir("wad-fingerprint");
  const { file } = await writeWad(root, [OGG_A, OGG_B, PNG_C]);
  const wad = await readWad(file);
  const index = buildFingerprintIndex(wad, 64);

  const key = OGG_B.subarray(0, 64).toString("hex");
  assert.deepEqual(index.get(key), [1]);
  assert.equal(entryFingerprint(wad, 0, 64), OGG_A.subarray(0, 64).toString("hex"));
});

test("补丁: 只改被替换条目的偏移/大小, 其余字节与 TOC 其它字段保持原样", async () => {
  const root = await makeTempDir("wad-patch");
  const { file, original } = await writeWad(root, [OGG_A, OGG_B, PNG_C]);
  const before = await readWad(file);

  const replacement = Buffer.concat([Buffer.from("OggS"), Buffer.from("ja_JP-choose-vo-103".repeat(12))]);
  const result = await patchWadEntries(file, [{ index: 0, data: replacement, label: "champion-choose-vo/103.ogg" }]);
  assert.equal(result.ok, true);
  assert.equal(result.patched, 1);
  assert.equal(result.bytesAppended > 0, true);

  const after = await readWad(file);
  // 被替换的条目: 指向文件尾部的新数据, 大小同步更新
  assert.equal(after.entries[0]!.size, replacement.length);
  assert.equal(after.entries[0]!.size2, replacement.length);
  assert.equal(after.buffer.subarray(after.entries[0]!.offset, after.entries[0]!.offset + 4).toString("ascii"), "OggS");
  assert.deepEqual(after.buffer.subarray(after.entries[0]!.offset, after.entries[0]!.offset + replacement.length), replacement);
  // 其它条目: 偏移、大小、哈希完全不变
  assert.deepEqual(after.entries.slice(1), before.entries.slice(1));
  // 条目数与签名块(前 268 字节)不变
  assert.equal(after.count, before.count);
  assert.deepEqual(after.buffer.subarray(0, 268), original.subarray(0, 268));
  // 追加的数据起点按 16 字节对齐(与原文件条目偏移的对齐方式一致)
  assert.equal(after.entries[0]!.offset % APPEND_ALIGN, 0);
  assert.equal(after.buffer.length % APPEND_ALIGN, 0);
  // 原文件已备份, 且备份与补丁前逐字节一致
  assert.equal(await isWadPatched(file), true);
  assert.deepEqual(await fs.readFile(backupPathFor(file)), original);
});

test("补丁: 多个条目一起替换, 互不影响", async () => {
  const root = await makeTempDir("wad-patch-many");
  const { file } = await writeWad(root, [OGG_A, OGG_B, PNG_C]);
  const dataA = Buffer.concat([Buffer.from("OggS"), Buffer.from("A".repeat(500))]);
  const dataB = Buffer.concat([Buffer.from("OggS"), Buffer.from("B".repeat(900))]);

  const result = await patchWadEntries(file, [
    { index: 0, data: dataA },
    { index: 1, data: dataB }
  ]);
  assert.equal(result.patched, 2);

  const wad = await readWad(file);
  assert.deepEqual(wad.buffer.subarray(wad.entries[0]!.offset, wad.entries[0]!.offset + dataA.length), dataA);
  assert.deepEqual(wad.buffer.subarray(wad.entries[1]!.offset, wad.entries[1]!.offset + dataB.length), dataB);
  assert.equal(wad.entries[0]!.size, dataA.length);
  assert.equal(wad.entries[1]!.size, dataB.length);
  assert.equal(wad.entries[2]!.size, PNG_C.length);
});

test("补丁: 二次补丁不覆盖首次备份(备份永远是原始文件)", async () => {
  const root = await makeTempDir("wad-patch-twice");
  const { file, original } = await writeWad(root, [OGG_A, OGG_B]);
  await patchWadEntries(file, [{ index: 0, data: Buffer.from("first-run-data") }]);
  await patchWadEntries(file, [{ index: 1, data: Buffer.from("second-run-data") }]);
  assert.deepEqual(await fs.readFile(backupPathFor(file)), original);
});

test("还原: 写回备份并删除备份文件, 内容与原始文件一致", async () => {
  const root = await makeTempDir("wad-restore");
  const { file, original } = await writeWad(root, [OGG_A, OGG_B, PNG_C]);
  await patchWadEntries(file, [{ index: 0, data: Buffer.from("changed") }]);
  assert.notDeepEqual(await fs.readFile(file), original);

  const restored = await restoreWad(file);
  assert.equal(restored.ok, true);
  assert.deepEqual(await fs.readFile(file), original);
  assert.equal(await isWadPatched(file), false);
  await assert.rejects(() => fs.stat(backupPathFor(file)));

  // 再还原一次: 幂等
  const again = await restoreWad(file);
  assert.equal(again.ok, true);
});

test("补丁: 提供 checksum 时写入 [+24], 不提供则保持原值", async () => {
  const root = await makeTempDir("wad-checksum");
  const { file } = await writeWad(root, [OGG_A, OGG_B, PNG_C]);
  const before = await readWad(file);
  const originalChecksum0 = before.entries[0]!.hash;
  const originalChecksum1 = before.entries[1]!.hash;
  const newChecksum = 0x0123456789abcdefn;

  await patchWadEntries(file, [
    { index: 0, data: Buffer.from("with-checksum"), checksum: newChecksum },
    { index: 1, data: Buffer.from("without-checksum") }
  ]);

  const after = await readWad(file);
  assert.equal(after.entries[0]!.hash, newChecksum);
  assert.equal(after.entries[1]!.hash, originalChecksum1);
  assert.notEqual(after.entries[0]!.hash, originalChecksum0);
});

test("异常输入: 非 RW 文件与空替换列表都安全返回", async () => {
  const root = await makeTempDir("wad-invalid");
  const bogus = path.join(root, "not-a-wad.wad");
  await fs.writeFile(bogus, "definitely not a wad file");
  await assert.rejects(() => readWad(bogus), /不是有效的 RW WAD/);

  const { file, original } = await writeWad(root, [OGG_A]);
  const result = await patchWadEntries(file, []);
  assert.equal(result.ok, true);
  assert.equal(result.patched, 0);
  assert.deepEqual(await fs.readFile(file), original);
  assert.equal(await isWadPatched(file), false);
});

/** 重构前的老实现: 整读 + Buffer.concat 再造一份。只用它来对照结果。 */
async function patchOldWay(
  file: string,
  items: { index: number; data: Buffer; checksum?: bigint }[]
): Promise<Buffer> {
  const wad = await readWad(file);
  const chunks: Buffer[] = [];
  let cursor = wad.buffer.length;
  const padding = (APPEND_ALIGN - (cursor % APPEND_ALIGN)) % APPEND_ALIGN;
  if (padding) {
    chunks.push(Buffer.alloc(padding));
    cursor += padding;
  }
  for (const item of items) {
    chunks.push(item.data);
    const base = TOC_OFFSET + item.index * ENTRY_SIZE;
    wad.buffer.writeUInt32LE(cursor, base + FIELD_OFFSET);
    wad.buffer.writeUInt32LE(item.data.length, base + FIELD_SIZE);
    wad.buffer.writeUInt32LE(item.data.length, base + FIELD_SIZE2);
    if (item.checksum !== undefined) wad.buffer.writeBigUInt64LE(item.checksum, base + FIELD_CHECKSUM);
    cursor += item.data.length;
    const pad = (APPEND_ALIGN - (cursor % APPEND_ALIGN)) % APPEND_ALIGN;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      cursor += pad;
    }
  }
  return Buffer.concat([wad.buffer, ...chunks]);
}

test("补丁: 改成流式落地后, 产物与老实现逐字节一致", async () => {
  const root = await makeTempDir("wad-stream-equal");
  const { file } = await writeWad(root, [OGG_A, OGG_B, PNG_C]);
  const items = [
    { index: 0, data: Buffer.from("new-voice-a".repeat(7)) },
    { index: 2, data: Buffer.from("new-icon".repeat(5)), checksum: BigInt("0xabcdef") }
  ];

  // 先算老实现的结果(只读不写)
  const expected = await patchOldWay(file, items);
  // 再跑新实现
  const result = await patchWadEntries(file, items);
  assert.equal(result.ok, true);
  assert.equal(result.patched, 2);
  assert.deepEqual(await fs.readFile(file), expected, "流式落地的字节必须与老实现完全相同");

  // 补完之后仍然能被正常解析, 且新数据确实指向追加区
  const after = await readWad(file);
  assert.equal(after.entries[0]!.size, items[0]!.data.length);
  assert.equal(after.entries[2]!.size, items[1]!.data.length);
  assert.deepEqual(
    after.buffer.subarray(after.entries[0]!.offset, after.entries[0]!.offset + after.entries[0]!.size),
    items[0]!.data
  );
});

test("补丁: 数据大小不是 16 的倍数时也逐字节一致(对齐分支)", async () => {
  const root = await makeTempDir("wad-stream-align");
  const { file } = await writeWad(root, [OGG_A, OGG_B]);
  const items = [
    { index: 0, data: Buffer.alloc(7, 1) },
    { index: 1, data: Buffer.alloc(31, 2) }
  ];
  const expected = await patchOldWay(file, items);
  const result = await patchWadEntries(file, items);
  assert.equal(result.patched, 2);
  assert.deepEqual(await fs.readFile(file), expected);
});

test("指纹: 按需读取建的索引与整读版本完全一致(含重复内容的多命中)", async () => {
  const root = await makeTempDir("wad-fingerprint-stream");
  const { file } = await writeWad(root, [OGG_A, OGG_B, PNG_C, OGG_A]);
  const wad = await readWad(file);
  const toc = await readWadEntries(file);

  const inMemory = buildFingerprintIndex(wad, 64);
  const streaming = await buildFingerprintIndexFromFile(toc.path, toc.entries, 64);
  const normalize = (m: Map<string, number[]>) =>
    [...m.entries()].map(([k, v]) => [k, [...v].sort()] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  assert.deepEqual(normalize(streaming), normalize(inMemory));

  // 内容相同的条目要落在同一个指纹下(多命中)
  const same = normalize(streaming).find(([, v]) => v.length === 2);
  assert.ok(same, "重复内容应产生多命中");

  // 按需读取的字节要与整读切片一致
  assert.deepEqual(await readEntryBytes(file, toc.entries[1]!, 64), OGG_B.subarray(0, 64));
  assert.deepEqual(await readEntryBytes(file, toc.entries[2]!, 9999), PNG_C);
});

test.after(async () => {
  await cleanupSuite();
});

/* ------------- zstd 压缩条目(游戏里的字体、贴图都在压缩条目里) ------------- */

/** 合成一个"条目本身是压缩帧"的 wad: [+12] 放压缩后大小, [+16] 放解压后大小。 */
function makeCompressedWad(items: { data: Buffer; rawSize: number }[]): Buffer {
  const header = Buffer.alloc(272);
  header.write("RW", 0, "ascii");
  header[2] = 3;
  header[3] = 4;
  header.writeUInt32LE(items.length, 268);
  const toc = Buffer.alloc(items.length * 32);
  let offset = 272 + items.length * 32;
  const datas: Buffer[] = [];
  items.forEach((item, i) => {
    const base = i * 32;
    toc.writeUInt32LE(offset, base + 8);
    toc.writeUInt32LE(item.data.length, base + 12);
    toc.writeUInt32LE(item.rawSize, base + 16);
    toc.writeBigUInt64LE(BigInt("0x9abc") * BigInt(i + 1), base + 24);
    datas.push(item.data);
    offset += item.data.length;
  });
  return Buffer.concat([header, toc, ...datas]);
}

test("zstd: 压缩/解压往返一致, 未压缩的数据原样返回", () => {
  const raw = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.from("font-data".repeat(500))]);
  const packed = compressEntry(raw);

  assert.equal(isZstdFrame(packed), true, "压缩结果必须是 zstd 帧");
  assert.equal(isZstdFrame(raw), false, "未压缩数据不能被误判成压缩帧");
  assert.equal(isCompressedEntry(packed), true);
  assert.deepEqual(decompressEntry(packed), raw);
  assert.deepEqual(decompressEntry(raw), raw, "非压缩数据必须原样返回");
});

test("zstd: 替换压缩条目后, [+12] 是压缩后大小, [+16] 是解压后大小, 内容能读回", async () => {
  const root = await makeTempDir("wad-zstd");
  const oldFont = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.from("old-font-glyphs".repeat(300))]);
  const file = path.join(root, "UI.wad.client");
  await fs.writeFile(file, makeCompressedWad([{ data: compressEntry(oldFont), rawSize: oldFont.length }]));

  const newFont = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.from("new-font-glyphs".repeat(420))]);
  const packedNew = compressEntry(newFont);
  const result = await patchWadEntries(file, [
    { index: 0, data: packedNew, uncompressedSize: newFont.length, label: "font" }
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.patched, 1);

  const toc = await readWadEntries(file);
  assert.equal(toc.entries[0]!.size, packedNew.length, "[+12] 应为压缩后大小");
  assert.equal(toc.entries[0]!.size2, newFont.length, "[+16] 应为解压后大小");
  assert.deepEqual(await readEntryContent(file, toc.entries[0]!), newFont, "解压后应等于新字体");
});

test("zstd: 不填 uncompressedSize 时两个大小字段都写成数据长度(旧的未压缩路径不变)", async () => {
  const root = await makeTempDir("wad-uncompressed");
  const { file } = await writeWad(root, [OGG_A, OGG_B]);
  const replacement = Buffer.from("plain-voice".repeat(40));
  await patchWadEntries(file, [{ index: 0, data: replacement }]);

  const toc = await readWadEntries(file);
  assert.equal(toc.entries[0]!.size, replacement.length);
  assert.equal(toc.entries[0]!.size2, replacement.length);
  assert.deepEqual(await readEntryContent(file, toc.entries[0]!), replacement);
});
