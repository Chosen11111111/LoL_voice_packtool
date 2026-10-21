/**
 * 游戏内(对局)字体: 从 UI.wad.client 里认出每一种字体, 并在语种之间搬运官方字体。
 *
 * 为什么要"认"而不是"按路径找": 资源包里的条目只有路径哈希, 没有文件名,
 * 所以只能把条目解开、读字体文件内部的 name 表(family / full name)来判定它是谁。
 *
 * 搬运策略: 官方字体全在**同一个** UI.wad.client 里(中文方正系 / 英文 Spiegel·Beaufort /
 * 日文 ...Ja / 韩文 UttumDotum), 所以换字体不需要下载、不需要打包、也不会增加体积 ——
 * 直接把目标语种字体条目的**原始压缩字节**原样写到中文字体条目上即可。
 */
import {
  decompressEntry,
  isCompressedEntry,
  patchWadEntries,
  readEntryBytes,
  readWadEntries,
  restoreWad,
  type PatchResult,
  type WadEntry
} from "./wadfile.ts";

/** 一个字体条目(资源包里的一个字体文件)。 */
export interface FontFace {
  index: number;
  /** 字体家族名(name 表 nameID 16 优先, 其次 1)。 */
  family: string;
  /** 完整名(含字重, nameID 4)。 */
  full: string;
  compressed: boolean;
  /** 条目在包里占用的字节数(压缩后)。 */
  size: number;
  /** 解压后的字节数。 */
  rawSize: number;
}

/** 从字体文件里读出家族名与完整名。读不出来返回空串。 */
export function fontNamesOf(buf: Buffer): { family: string; full: string } {
  const empty = { family: "", full: "" };
  if (buf.length < 12) return empty;
  try {
    const tables = buf.readUInt16BE(4);
    if (tables <= 0 || tables > 512) return empty;
    let offset = -1;
    let length = 0;
    for (let i = 0; i < tables; i += 1) {
      const record = 12 + i * 16;
      if (record + 16 > buf.length) break;
      if (buf.subarray(record, record + 4).toString("ascii") !== "name") continue;
      offset = buf.readUInt32BE(record + 8);
      length = buf.readUInt32BE(record + 12);
      break;
    }
    if (offset < 0 || offset + length > buf.length) return empty;

    const count = buf.readUInt16BE(offset + 2);
    const storage = offset + buf.readUInt16BE(offset + 4);
    const picked: Record<number, string> = {};
    for (let i = 0; i < count; i += 1) {
      const record = offset + 6 + i * 12;
      if (record + 12 > buf.length) break;
      const platform = buf.readUInt16BE(record);
      const nameId = buf.readUInt16BE(record + 6);
      if (nameId !== 1 && nameId !== 4 && nameId !== 16) continue;
      if (picked[nameId]) continue;
      const len = buf.readUInt16BE(record + 8);
      const start = storage + buf.readUInt16BE(record + 10);
      if (start + len > buf.length) continue;
      const raw = buf.subarray(start, start + len);
      if (platform === 3 || platform === 0) {
        let text = "";
        for (let k = 0; k + 1 < raw.length; k += 2) {
          const code = raw.readUInt16BE(k);
          if (code) text += String.fromCharCode(code);
        }
        picked[nameId] = text.trim();
      } else if (platform === 1) {
        picked[nameId] = raw.toString("latin1").trim();
      }
    }
    return { family: picked[16] ?? picked[1] ?? "", full: picked[4] ?? picked[1] ?? "" };
  } catch {
    return empty;
  }
}

/** 扫一个资源包里的所有字体条目。 */
export async function scanFontFaces(wadPath: string): Promise<FontFace[]> {
  const toc = await readWadEntries(wadPath);
  const handle = await (await import("node:fs/promises")).open(wadPath, "r");
  const head = Buffer.alloc(4);
  const faces: FontFace[] = [];
  try {
    for (const entry of toc.entries) {
      // 字体文件解压后一般在 30 KB ~ 8 MB
      if (entry.size2 < 16 * 1024 || entry.size2 > 8 * 1024 * 1024) continue;
      await handle.read(head, 0, 4, entry.offset);
      const compressed = isCompressedEntry(head);
      const raw = await readEntryBytes(wadPath, entry, entry.size, handle);
      const content = compressed ? decompressEntry(raw) : raw;
      if (content.length < 12) continue;
      const magic = content.subarray(0, 4).toString("hex");
      const tag = content.subarray(0, 4).toString("ascii");
      if (magic !== "00010000" && tag !== "OTTO" && tag !== "ttcf" && tag !== "true") continue;
      const { family, full } = fontNamesOf(content);
      if (!family) continue;
      faces.push({ index: entry.index, family, full, compressed, size: entry.size, rawSize: content.length });
    }
  } finally {
    await handle.close();
  }
  return faces;
}

/* ------------------------------------------------------------- 语种 → 字体 */

/** 可以替换的字体角色。 */
export type FontRole = "cjk" | "cjk-bold" | "cjk-semibold" | "latin-body" | "latin-semi" | "latin-bold" | "jp-body" | "jp-bold" | "kr";

/** 认这个字体是谁(中文字体 / 英文字体 / 日文字体 / 韩文字体)。 */
export function roleOf(family: string): FontRole | null {
  const name = family.trim();
  if (!name) return null;
  if (name.startsWith("FZ") || name.startsWith("方正")) return "cjk";
  if (name === "UttumDotum") return "kr";
  if (name.endsWith(" Ja")) return "jp-body";
  if (name === "Spiegel") return "latin-body";
  if (name.startsWith("Beaufort for LOL")) return "latin-body";
  return null;
}

/** 目标语种要用哪些"源字体"来填中文字体那几个条目。null = 不需要动(中文)。 */
function sourcePreference(locale: string): { regular: string; semi: string; bold: string } | null {
  const code = locale.toLowerCase();
  if (code.startsWith("zh")) return null;
  if (code.startsWith("ja")) return { regular: "Spiegel Ja", semi: "Spiegel Ja", bold: "Spiegel Ja Bold" };
  if (code.startsWith("ko")) return { regular: "UttumDotum", semi: "UttumDotum", bold: "UttumDotum" };
  return { regular: "Spiegel", semi: "Spiegel SemiBold", bold: "Spiegel Bold" };
}

/** 中文字体条目里, 哪一条对应哪个字重。 */
function targetWeight(family: string): "regular" | "semi" | "bold" {
  if (/DaHei|Bd|Bold/i.test(family)) return "bold";
  if (/XHY|ZHYS|Semi/i.test(family)) return "semi";
  return "regular";
}

export interface FontPatch {
  sourceIndex: number;
  targetIndex: number;
  sourceName: string;
  targetName: string;
}

/**
 * 算出"把哪一条换成哪一条"。
 * 中文不需要动(官方本来就是中文字体), 返回空数组。
 */
export function planFontPatches(locale: string, faces: FontFace[]): FontPatch[] {
  const prefer = sourcePreference(locale);
  if (!prefer) return [];
  const targets = faces.filter((f) => roleOf(f.family) === "cjk");
  if (!targets.length) return [];
  const byFull = (name: string) => faces.find((f) => f.full === name) ?? faces.find((f) => f.full.startsWith(name + " "));

  const patches: FontPatch[] = [];
  for (const target of targets) {
    const want = prefer[targetWeight(target.family)];
    const source = byFull(want);
    if (!source || source.index === target.index) continue;
    patches.push({ sourceIndex: source.index, targetIndex: target.index, sourceName: source.full, targetName: target.full });
  }
  return patches;
}

/* ------------------------------------------------------------------ 应用 */

/** 把源字体条目的原始字节搬到目标条目上(不重新压缩, 直接搬官方的压缩帧)。 */
export async function applyFontPatches(wadPath: string, patches: FontPatch[]): Promise<PatchResult> {
  const toc = await readWadEntries(wadPath);
  const items: { index: number; data: Buffer; uncompressedSize?: number; label?: string }[] = [];
  // 先把源条目内容全部读出来 —— 补丁会改写 TOC, 之后再按旧偏移读就不对了
  for (const patch of patches) {
    const entry: WadEntry | undefined = toc.entries[patch.sourceIndex];
    if (!entry) continue;
    const raw = await readEntryBytes(wadPath, entry, entry.size);
    const compressed = isCompressedEntry(raw);
    items.push({
      index: patch.targetIndex,
      data: raw,
      uncompressedSize: compressed ? entry.size2 : raw.length,
      label: patch.targetName + " ← " + patch.sourceName
    });
  }
  if (!items.length) {
    return { ok: true, patched: 0, skipped: 0, backup: null, bytesAppended: 0, message: "没有需要替换的字体", labels: [], skippedLabels: [] };
  }
  return patchWadEntries(wadPath, items);
}

/** 还原字体(把整个 UI.wad.client 从备份恢复)。 */
export async function restoreFonts(wadPath: string): Promise<{ ok: boolean; message: string }> {
  return restoreWad(wadPath);
}
