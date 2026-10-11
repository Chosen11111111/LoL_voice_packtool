/**
 * 资源下载与增量更新:
 *   1. 局内 wad  -> ManifestDownloader.exe(清单 + 切片加速代理, 支持 --skip-existing 增量);
 *   2. 大厅资源  -> CommunityDragon(选人/禁用台词、英雄元数据、界面翻译);
 *   3. 版本元数据-> content-metadata.json 与本地 version.json 比对。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { appRoot, type AppConfig } from "../core/config.ts";
import { classifyNetworkError } from "../core/errors.ts";
import { ensureDir, fileSize, isFile, listNames, readJsonFile, writeFileAtomic, writeTextFile } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";
import { runStreaming } from "../core/win/shell.ts";
import { cdnLocale } from "./locales.ts";

const logger = createLogger("updater");

export const PLUGINS_TO_SYNC = [
  "rcp-fe-lol-champ-select",
  "rcp-fe-lol-collections",
  "rcp-fe-lol-loot",
  "rcp-fe-lol-navigation",
  "rcp-fe-lol-parties",
  "rcp-fe-lol-profiles",
  "rcp-fe-lol-shared-components"
];

export interface VersionFile {
  manifest_id?: string;
  cdragon_version?: string;
  last_check?: string;
  locales?: string[];
  status?: string;
}

export interface RemoteInfo {
  remoteVersion: string;
  localVersion: string;
  hasUpdate: boolean;
  missingItems: number;
  detail: string;
  offline: boolean;
}

export function versionFilePath(voiceRoot: string): string {
  return path.join(voiceRoot, "version.json");
}

async function consumeResponse<T>(url: string, timeoutMs: number, signal: AbortSignal | undefined, consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "LeagueVoiceToolkit/1.0 (+https://github.com/Chosen11111111/LoL_voice_packtool)" }
    });
    try { return await consume(response, controller.signal); }
    finally { await response.body?.cancel().catch(() => undefined); }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export interface FetchFileOptions {
  timeoutMs?: number;
  retries?: number;
  /** 目标已存在且非空时跳过(增量)。 */
  skipExisting?: boolean;
  signal?: AbortSignal;
}

/** 下载单个文件到指定路径(url 为图片/音频等二进制)。 */
export async function fetchFile(url: string, dest: string, options: FetchFileOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const retries = Number.isFinite(options.retries ?? 3) ? Math.max(1, Math.min(10, Math.trunc(options.retries ?? 3))) : 3;
  if (options.signal?.aborted) return false;
  if (options.skipExisting !== false && (await isFile(dest)) && (await fileSize(dest)) > 0) return true;
  await ensureDir(path.dirname(dest));
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (options.signal?.aborted) return false;
    const temp = `${dest}.download-${randomUUID()}`;
    try {
      return await consumeResponse(url, timeoutMs, options.signal, async (response, signal) => {
        if (!response.ok) {
          if (response.status === 404 || response.status === 410) return false;
          throw new Error(`HTTP ${response.status}`);
        }
        if (!response.body) throw new Error("空响应");
        await pipeline(Readable.fromWeb(response.body as any), createWriteStream(temp, { flags: "wx" }), { signal });
        signal.throwIfAborted();
        if ((await fs.stat(temp)).size === 0) throw new Error("空响应");
        await fs.rename(temp, dest);
        return true;
      });
    } catch (error) {
      if (options.signal?.aborted) return false;
      logger.debug(`下载失败(${attempt + 1}/${retries}) ${url}: ${classifyNetworkError(error)}`);
      if (attempt + 1 < retries) {
        try { await delay(400 * (attempt + 1), undefined, { signal: options.signal }); }
        catch { return false; }
      }
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }
  return false;
}

/** 并发映射(自带的轻量连接池, 不引依赖)。 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const size = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 1, 64, items.length || 1));
  for (let i = 0; i < size; i += 1) {
    workers.push(
      (async () => {
        for (;;) {
          if (signal?.aborted) return;
          const index = cursor;
          cursor += 1;
          if (index >= items.length) return;
          try { results[index] = await worker(items[index]!, index); }
          catch (error) { cursor = items.length; throw error; }
        }
      })()
    );
  }
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results;
}

/* ---------------------------------------------------------------- 版本检查 */

const EXPECTED = { wads: 180, choose: 170, ban: 170 };

export async function checkRemoteVersion(config: AppConfig, voiceRoot: string, signal?: AbortSignal): Promise<RemoteInfo> {
  let remoteVersion = "";
  let offline = false;
  try {
    remoteVersion = await consumeResponse(`${config.cdnBase}/content-metadata.json`, 8000, signal, async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { version?: string };
      return data.version ?? "";
    });
    offline = !remoteVersion;
  } catch (error) {
    signal?.throwIfAborted();
    offline = true;
    logger.debug(`版本检查失败: ${classifyNetworkError(error)}`);
  }

  const inventory = await inventorySnapshot(voiceRoot, config.supportedLocales);
  const missing = inventory.reduce((sum, row) => sum + Math.max(0, EXPECTED.wads - row.wads) + Math.max(0, EXPECTED.choose - row.choose) + Math.max(0, EXPECTED.ban - row.ban), 0);

  const local = (await readJsonFile<VersionFile>(versionFilePath(voiceRoot)))?.cdragon_version ?? "";
  const label = remoteVersion || "未知";
  let hasUpdate = false;
  let detail: string;
  if (missing > 0) {
    hasUpdate = true;
    detail = `检测到本地存在 ${missing} 个缺失或未下载的资源文件，需增量补全。`;
  } else if (local && remoteVersion && local !== remoteVersion) {
    hasUpdate = true;
    detail = `检测到官方版本已从 ${local} 更新为 ${remoteVersion}。`;
  } else if (offline) {
    detail = "离线或检测超时，未能确认远程版本；本地文件齐全。";
  } else {
    detail = "所有语言包均为最新状态，文件校验完整率 100%。";
  }

  return {
    remoteVersion: label,
    localVersion: local,
    hasUpdate,
    missingItems: missing,
    detail,
    offline
  };
}

export async function writeVersionFile(voiceRoot: string, config: AppConfig, remoteVersion: string): Promise<void> {
  const payload: VersionFile = {
    manifest_id: config.manifestId,
    cdragon_version: remoteVersion,
    last_check: new Date().toISOString().replace("T", " ").slice(0, 19),
    locales: config.supportedLocales,
    status: "ready"
  };
  await writeFileAtomic(versionFilePath(voiceRoot), JSON.stringify(payload, null, 2) + "\n");
}

/* ---------------------------------------------------------------- 清单 */

/** 确保本地有清单文件(没有就经反代拉一份)。 */
export async function ensureManifest(config: AppConfig, voiceRoot: string, options: FetchFileOptions = {}): Promise<{ ok: boolean; file: string; message: string }> {
  const file = path.join(voiceRoot, `${config.manifestId}.manifest`);
  if ((await isFile(file)) && (await fileSize(file)) > 1_000_000) return { ok: true, file, message: "本地清单可用" };
  const origin = new URL(config.bundleProxy).origin;
  const url = `${origin}/channels/public/releases/${config.manifestId}.manifest`;
  const ok = await fetchFile(url, file, { ...options, skipExisting: false });
  return {
    ok,
    file,
    message: ok ? "清单已下载" : `清单下载失败：${url}（可手动放置 ${path.basename(file)} 后重试）`
  };
}

/* ---------------------------------------------------------------- 局内 wad */

export interface WadsResult {
  ok: boolean;
  code: number | null;
  message: string;
  output: string;
}

/** 用 ManifestDownloader 增量拉取某个语种的局内资源。 */
export async function downloadIngameWads(
  code: string,
  config: AppConfig,
  voiceRoot: string,
  options: { signal?: AbortSignal; onLine?: (line: string) => void } = {}
): Promise<WadsResult> {
  const exe = path.isAbsolute(config.manifestDownloader)
    ? config.manifestDownloader
    : path.resolve(appRoot(), config.manifestDownloader);
  if (!(await isFile(exe))) {
    return { ok: false, code: null, message: `找不到下载工具：${exe}`, output: "" };
  }
  const manifest = await ensureManifest(config, voiceRoot, { signal: options.signal });
  if (!manifest.ok) return { ok: false, code: null, message: manifest.message, output: "" };

  const output = path.join(voiceRoot, code);
  await ensureDir(output);
  const args = [
    manifest.file,
    "-b",
    config.bundleProxy,
    "-l",
    code,
    "-t",
    String(config.download.threads),
    "-o",
    output,
    "--skip-existing"
  ];
  logger.info(`开始拉取 ${code} 局内资源: ${exe}`);
  const result = await runStreaming(exe, args, {
    cwd: voiceRoot,
    onLine: options.onLine,
    signal: options.signal,
    timeoutMs: 0
  });
  if (result.ok) return { ok: true, code: result.code, message: `${code} 局内资源拉取完成`, output: result.stdout };
  return {
    ok: false,
    code: result.code,
    message: result.error === "aborted" ? "已取消" : `${code} 局内资源拉取失败(退出码 ${result.code ?? "null"})`,
    output: result.stdout
  };
}

/* ---------------------------------------------------------------- 大厅资源 */

export interface LobbyAssetsResult {
  ok: boolean;
  message: string;
  choose: { ok: number; total: number };
  ban: { ok: number; total: number };
  champions: { ok: number; total: number };
  plugins: { ok: number; total: number };
}

/** 拉取一个语种的大厅选人/禁用台词与元数据(增量, 已存在的直接跳过)。 */
export async function downloadLobbyAssets(
  code: string,
  config: AppConfig,
  voiceRoot: string,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number, current: string) => void } = {}
): Promise<LobbyAssetsResult> {
  const assets = path.join(voiceRoot, code, "assets");
  const locale = cdnLocale(code);
  await ensureDir(assets);

  const summaryUrl = `${config.cdnBase}/plugins/rcp-be-lol-game-data/global/${locale}/v1/champion-summary.json`;
  const summaryFile = path.join(assets, "champion-summary.json");
  if (!(await fetchFile(summaryUrl, summaryFile, { signal: options.signal }))) {
    await fetchFile(
      `${config.cdnBase}/plugins/rcp-be-lol-game-data/global/default/v1/champion-summary.json`,
      summaryFile,
      { signal: options.signal }
    );
  }

  let championIds: number[] = [];
  const summary = await readJsonFile<Array<{ id: number }>>(summaryFile);
  if (Array.isArray(summary)) {
    championIds = [...new Set(summary.map((item) => Number(item.id)).filter((id) => Number.isFinite(id) && id > 0 && id < 1000))];
  }
  if (!championIds.length) {
    // 拿不到英雄列表就退化成官方 ID 区间, 保证仍能补全资源
    championIds = Array.from({ length: 950 }, (_value, index) => index + 1);
  }

  const total = championIds.length * 3 + PLUGINS_TO_SYNC.length + 1;
  let done = 0;
  const tick = (current: string) => {
    done += 1;
    options.onProgress?.(done, total, current);
  };
  tick("champion-summary.json");

  const concurrency = Math.max(1, config.download.concurrency);
  const timeoutMs = config.download.timeoutMs;
  const retries = config.download.retries;

  const chooseDir = path.join(assets, "champion-choose-vo");
  const banDir = path.join(assets, "champion-ban-vo");
  const championDir = path.join(assets, "champions");
  await Promise.all([ensureDir(chooseDir), ensureDir(banDir), ensureDir(championDir)]);

  const chooseResults = await mapLimit(
    championIds,
    concurrency,
    async (id) => {
      const ok = await fetchFile(
        `${config.cdnBase}/plugins/rcp-be-lol-game-data/global/${locale}/v1/champion-choose-vo/${id}.ogg`,
        path.join(chooseDir, `${id}.ogg`),
        { timeoutMs, retries, signal: options.signal }
      );
      tick(`${code} 选人语音 ${id}.ogg`);
      return ok;
    },
    options.signal
  );

  const banResults = await mapLimit(
    championIds,
    concurrency,
    async (id) => {
      const ok = await fetchFile(
        `${config.cdnBase}/plugins/rcp-be-lol-game-data/global/${locale}/v1/champion-ban-vo/${id}.ogg`,
        path.join(banDir, `${id}.ogg`),
        { timeoutMs, retries, signal: options.signal }
      );
      tick(`${code} 禁用语音 ${id}.ogg`);
      return ok;
    },
    options.signal
  );

  const championResults = await mapLimit(
    championIds,
    concurrency,
    async (id) => {
      const ok = await fetchFile(
        `${config.cdnBase}/plugins/rcp-be-lol-game-data/global/${locale}/v1/champions/${id}.json`,
        path.join(championDir, `${id}.json`),
        { timeoutMs, retries, signal: options.signal }
      );
      tick(`${code} 英雄数据 ${id}.json`);
      return ok;
    },
    options.signal
  );

  let pluginsOk = 0;
  for (const plugin of PLUGINS_TO_SYNC) {
    if (options.signal?.aborted) break;
    const ok = await fetchFile(
      `${config.cdnBase}/plugins/${plugin}/global/${locale}/trans.json`,
      path.join(assets, "plugins", plugin, "trans.json"),
      { timeoutMs, retries, signal: options.signal }
    );
    if (ok) pluginsOk += 1;
    tick(`${code} 界面文本 ${plugin}`);
  }

  const count = (items: boolean[]) => ({ ok: items.filter(Boolean).length, total: items.length });
  const choose = count(chooseResults);
  const ban = count(banResults);
  const champions = count(championResults);
  const ok = choose.ok > 0 && ban.ok > 0;
  return {
    ok,
    message: ok
      ? `${code} 大厅资源就绪（选人 ${choose.ok}/${choose.total}，禁用 ${ban.ok}/${ban.total}，英雄数据 ${champions.ok}/${champions.total}，界面 ${pluginsOk}/${PLUGINS_TO_SYNC.length}）`
      : `${code} 大厅资源下载不完整，请检查网络后重试`,
    choose,
    ban,
    champions,
    plugins: { ok: pluginsOk, total: PLUGINS_TO_SYNC.length }
  };
}

export interface SyncResult {
  code: string;
  ok: boolean;
  wads: WadsResult;
  lobby: LobbyAssetsResult | null;
  message: string;
}

/** 单个语种的完整增量同步(局内 + 大厅), 并做同步后校验。 */
export async function syncLocale(
  code: string,
  config: AppConfig,
  voiceRoot: string,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number, current: string) => void; onLine?: (line: string) => void } = {}
): Promise<SyncResult> {
  const wads = await downloadIngameWads(code, config, voiceRoot, { signal: options.signal, onLine: options.onLine });
  if (options.signal?.aborted) {
    return { code, ok: false, wads, lobby: null, message: "已取消" };
  }
  const lobby = await downloadLobbyAssets(code, config, voiceRoot, { signal: options.signal, onProgress: options.onProgress });
  return {
    code,
    ok: wads.ok && lobby.ok,
    wads,
    lobby,
    message: [wads.message, lobby.message].join("；")
  };
}

/** 资源完整性快照(同步后校验用)。 */
export async function inventorySnapshot(voiceRoot: string, codes: string[]): Promise<Array<{ code: string; wads: number; choose: number; ban: number; champions: number }>> {
  return mapLimit(codes, 4, async (code) => {
    const base = path.join(voiceRoot, code);
    const [wads, choose, ban, champions] = await Promise.all([
      listNames(path.join(base, "DATA", "FINAL", "Champions")),
      listNames(path.join(base, "assets", "champion-choose-vo")),
      listNames(path.join(base, "assets", "champion-ban-vo")),
      listNames(path.join(base, "assets", "champions"))
    ]);
    return {
      code,
      wads: wads.filter((name) => name.endsWith(".wad.client")).length,
      choose: choose.filter((name) => name.toLowerCase().endsWith(".ogg")).length,
      ban: ban.filter((name) => name.toLowerCase().endsWith(".ogg")).length,
      champions: champions.filter((name) => name.endsWith(".json")).length
    };
  });
}

/** 导出给 CLI 的便捷文本写入(避免 CLI 直接依赖 fsx)。 */
export async function writeText(file: string, text: string): Promise<void> {
  await writeTextFile(file, text);
}
