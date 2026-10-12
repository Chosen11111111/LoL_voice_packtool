/**
 * 大厅选人语音的 WAD 补丁方案(不注入进程)。
 *
 * 流程:
 *   1. 定位客户端语种资源包 <locale>-assets.wad;
 *   2. 建立"条目 → 英雄 ID"映射 —— 路径哈希算法未公开, 因此改用**内容指纹**:
 *      从 CommunityDragon 取该客户端语种的原始音频, 与 wad 条目数据逐字节比对;
 *   3. 用本地语音包(目标语种)的音频替换这些条目的数据(追加写入, 只改 TOC 里的偏移与大小);
 *   4. 首次补丁前整体备份原 wad, 还原即写回备份。
 *
 * 该映射结果缓存到磁盘, 同一份 wad 只需识别一次。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isFile, ensureDir, readJsonFile, writeFileAtomic, removeQuietly } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";
import { cdnLocale, localeDisplayName } from "./locales.ts";
import {
  backupPathFor,
  buildFingerprintIndexFromFile,
  isWadPatched,
  patchWadEntries,
  readEntryBytes,
  readWadEntries,
  restoreWad,
  type PatchItem,
  type PatchResult,
  type WadToc
} from "./wadfile.ts";

const logger = createLogger("lobby-wad");

export const CHOOSE_TYPE = "champion-choose-vo";
export const BAN_TYPE = "champion-ban-vo";

export interface EntryMapping {
  /** wad 文件的标识(大小+条目数), 变了就重新识别。 */
  wadKey: string;
  cdnLocale: string;
  /** 英雄 ID -> wad 条目序号 */
  choose: Record<string, number>;
  ban: Record<string, number>;
}

/**
 * wad 身份标识。
 * 不能用文件大小 —— 补丁之后文件会变长, 那样缓存会失效并触发无谓的重新识别。
 * 条目哈希在补丁前后保持不变, 因此用 "条目数 + 全部条目哈希的折叠值" 作为身份。
 */
export function wadKeyOf(wad: WadToc): string {
  let fold = 0n;
  for (const entry of wad.entries) {
    fold = (fold ^ entry.hash) * 0x100000001b3n & 0xffffffffffffffffn;
  }
  return `${wad.version}-${wad.count}-${fold.toString(16)}`;
}

function mappingFile(appDir: string, wadFile: string): string {
  const name = path.basename(wadFile, ".wad");
  return path.join(appDir, ".tmp", `wad-map-${name}.json`);
}

const USER_AGENT = "LeagueVoiceToolkit/1.0 (+https://github.com/Chosen11111111/LoL_voice_packtool)";

/** 带一次重试的抓取(CDN 偶发限流/超时, 重试能显著提高识别完整度)。 */
async function withRetry<T>(task: () => Promise<T | null>, attempts = 3, delayMs = 400): Promise<T | null> {
  let last: T | null = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await task();
    if (last !== null) return last;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
  }
  return last;
}

/** 取前 N 字节(Range 请求); 服务端不支持 Range 时返回完整响应的前缀。 */
async function fetchFirstBytes(url: string, bytes: number, timeoutMs = 20000): Promise<Buffer | null> {
  return withRetry(() => fetchFirstBytesOnce(url, bytes, timeoutMs));
}

async function fetchFirstBytesOnce(url: string, bytes: number, timeoutMs = 20000): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Range: `bytes=0-${bytes - 1}` }
      });
      if (response.status === 206) return Buffer.from(await response.arrayBuffer());
      if (!response.ok) return null;
      const full = Buffer.from(await response.arrayBuffer());
      return full.subarray(0, bytes);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** 取完整文件(仅在指纹撞车需要精确比对时使用)。 */
async function fetchBytes(url: string, timeoutMs = 30000): Promise<Buffer | null> {
  return withRetry(() => fetchBytesOnce(url, timeoutMs));
}

async function fetchBytesOnce(url: string, timeoutMs = 30000): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
      if (!response.ok) return null;
      return Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

export interface IdentifyOptions {
  wad: WadToc;
  appDir: string;
  cdnBase: string;
  clientLocale: string;
  ids: number[];
  concurrency?: number;
  onLog?: (line: string) => void;
  onProgress?: (done: number, total: number, current: string) => void;
  /** 忽略缓存强制重新识别。 */
  force?: boolean;
}

/** 建立 英雄 ID -> 条目序号 的映射(内容指纹比对, 带磁盘缓存)。 */
export async function identifyEntries(options: IdentifyOptions): Promise<EntryMapping> {
  const log = options.onLog ?? (() => undefined);
  const progress = options.onProgress ?? (() => undefined);
  const cacheFile = mappingFile(options.appDir, options.wad.path);
  const wadKey = wadKeyOf(options.wad);
  const cdn = cdnLocale(options.clientLocale);

  // 复用同版本 wad 的既有映射(支持断点续跑: 只补齐还没识别出来的英雄)
  const mapping: EntryMapping = { wadKey, cdnLocale: cdn, choose: {}, ban: {} };
  if (!options.force) {
    const cached = await readJsonFile<EntryMapping>(cacheFile);
    if (cached && cached.wadKey === wadKey && cached.cdnLocale === cdn) {
      Object.assign(mapping.choose, cached.choose ?? {});
      Object.assign(mapping.ban, cached.ban ?? {});
      log(
        `复用已缓存的条目映射：选人 ${Object.keys(mapping.choose).length}，禁用 ${Object.keys(mapping.ban).length}`
      );
    }
  }

  // 按需读取: 每个条目只读前 64 字节, 不再把整个资源包读进内存
  const index = await buildFingerprintIndexFromFile(options.wad.path, options.wad.entries, 64);
  const base = `${options.cdnBase}/plugins/rcp-be-lol-game-data/global/${cdn}/v1`;
  const tasks: Array<{ type: string; id: number }> = [];
  for (const id of options.ids) {
    if (!(String(id) in mapping.choose)) tasks.push({ type: CHOOSE_TYPE, id });
    if (!(String(id) in mapping.ban)) tasks.push({ type: BAN_TYPE, id });
  }
  if (!tasks.length) {
    log("条目映射已完整, 无需重新识别");
    return mapping;
  }

  let done = 0;
  let sinceSave = 0;
  const total = tasks.length;
  const save = async () => {
    await ensureDir(path.dirname(cacheFile));
    await writeFileAtomic(cacheFile, JSON.stringify(mapping, null, 2) + "\n");
  };
  const concurrency = Math.max(1, options.concurrency ?? 24);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const at = cursor;
      cursor += 1;
      if (at >= tasks.length) return;
      const task = tasks[at]!;
      const url = `${base}/${task.type}/${task.id}.ogg`;
      const head = await fetchFirstBytes(url, 64);
      done += 1;
      sinceSave += 1;
      if (head && head.length >= 64) {
        const hits = index.get(head.toString("hex"));
        const table = task.type === CHOOSE_TYPE ? mapping.choose : mapping.ban;
        if (hits && hits.length === 1) {
          table[String(task.id)] = hits[0]!;
        } else if (hits && hits.length > 1) {
          // 指纹撞车: 用完整文件精确比对(极少数)
          const full = await fetchBytes(url);
          let exact: number | undefined;
          if (full) {
            for (const candidate of hits) {
              const entry = options.wad.entries[candidate]!;
              if (entry.size !== full.length) continue;
              // 极少数指纹撞车才走到这里: 只读这一条, 不整读资源包
              const bytes = await readEntryBytes(options.wad.path, entry, entry.size);
              if (bytes.equals(full)) {
                exact = candidate;
                break;
              }
            }
          }
          if (exact !== undefined) table[String(task.id)] = exact;
        }
      }
      progress(done, total, `${task.type}/${task.id}.ogg`);
      if (sinceSave >= 40) {
        sinceSave = 0;
        await save();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  await save();

  log(
    `条目识别完成：选人语音 ${Object.keys(mapping.choose).length}/${options.ids.length}，` +
      `禁用语音 ${Object.keys(mapping.ban).length}/${options.ids.length}`
  );
  return mapping;
}

export interface ApplyLobbyOptions {
  wadFile: string;
  voiceRoot: string;
  locale: string;
  appDir: string;
  cdnBase: string;
  clientLocale: string;
  ids: number[];
  onLog?: (line: string) => void;
  onProgress?: (done: number, total: number, current: string) => void;
  signal?: AbortSignal;
}

export interface ApplyLobbyResult {
  ok: boolean;
  message: string;
  wad_file: string;
  backup: string | null;
  patched: number;
  missing: number;
  mapping: { choose: number; ban: number };
  detail: string[];
}

/** 全量替换: 把本地语音包里的选人/禁用台词写进客户端资源包。 */
export async function applyLobbyVoiceWad(options: ApplyLobbyOptions): Promise<ApplyLobbyResult> {
  const log = options.onLog ?? (() => undefined);
  const progress = options.onProgress ?? (() => undefined);
  const empty: ApplyLobbyResult = {
    ok: false,
    message: "",
    wad_file: options.wadFile,
    backup: null,
    patched: 0,
    missing: 0,
    mapping: { choose: 0, ban: 0 },
    detail: []
  };

  // 只读目录: 整个资源包可能几百 MB, 没必要读进内存
  const wad = await readWadEntries(options.wadFile);
  const wadSize = (await fs.stat(options.wadFile)).size;
  log(`资源包: ${options.wadFile}（${wad.count} 个条目，${(wadSize / 1048576).toFixed(1)} MB）`);

  const mapping = await identifyEntries({
    wad,
    appDir: options.appDir,
    cdnBase: options.cdnBase,
    clientLocale: options.clientLocale,
    ids: options.ids,
    onLog: log,
    onProgress: progress
  });
  if (!Object.keys(mapping.choose).length && !Object.keys(mapping.ban).length) {
    return { ...empty, message: "没有识别到任何可用条目，无法替换（CDN 不可达或版本不匹配）" };
  }

  const items: PatchItem[] = [];
  const detail: string[] = [];
  let missing = 0;
  const collect = async (type: string, table: Record<string, number>) => {
    for (const [id, entryIndex] of Object.entries(table)) {
      if (options.signal?.aborted) return;
      const file = path.join(options.voiceRoot, options.locale, "assets", type, `${id}.ogg`);
      if (!(await isFile(file))) {
        missing += 1;
        continue;
      }
      const data = await fs.readFile(file);
      items.push({ index: entryIndex, data, label: `${type}/${id}.ogg` });
    }
  };
  await collect(CHOOSE_TYPE, mapping.choose);
  await collect(BAN_TYPE, mapping.ban);

  if (!items.length) {
    return {
      ...empty,
      mapping: { choose: Object.keys(mapping.choose).length, ban: Object.keys(mapping.ban).length },
      message: `本地语音包里没有找到对应音频：${path.join(options.voiceRoot, options.locale, "assets")}`
    };
  }

  const result: PatchResult = await patchWadEntries(options.wadFile, items);
  detail.push(`替换条目 ${result.patched} 个（选人 ${Object.keys(mapping.choose).length} / 禁用 ${Object.keys(mapping.ban).length}）`);
  if (missing) detail.push(`本地缺少 ${missing} 个对应音频，已跳过`);
  if (result.skipped) detail.push(`跳过 ${result.skipped} 个条目`);

  return {
    ok: result.ok,
    message: result.ok
      ? `已把 ${localeDisplayName(options.locale)} 的选人/禁用台词写入客户端资源包（${result.patched} 个条目），重启客户端后生效`
      : result.message,
    wad_file: options.wadFile,
    backup: result.backup,
    patched: result.patched,
    missing,
    mapping: { choose: Object.keys(mapping.choose).length, ban: Object.keys(mapping.ban).length },
    detail
  };
}

export interface RestoreLobbyResult {
  ok: boolean;
  message: string;
  wad_file: string;
}

export async function restoreLobbyVoiceWad(wadFile: string): Promise<RestoreLobbyResult> {
  if (!(await isWadPatched(wadFile))) {
    return { ok: true, message: "没有找到备份，无需还原", wad_file: wadFile };
  }
  const result = await restoreWad(wadFile);
  return { ok: result.ok, message: result.message, wad_file: wadFile };
}

export async function lobbyPatchState(wadFile: string | null): Promise<{ patched: boolean; backup: string | null }> {
  if (!wadFile) return { patched: false, backup: null };
  const backup = backupPathFor(wadFile);
  const patched = await isWadPatched(wadFile);
  return { patched, backup: patched ? backup : null };
}

export { removeQuietly };
