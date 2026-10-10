/**
 * Pengu Loader 集成: d3d9 加载桩、Rose 加载器配置、精简语音加载器目录。
 *
 * 大厅语音的实现原理: 客户端目录放一个 d3d9 加载桩 -> 加载桩读取 Rose 的 config.ini
 * 得到 loaderpath -> 从该目录加载 core.dll -> core 加载 plugins 下的语音插件。
 * 换肤关掉、只开语音时, loaderpath 指向一个只含语音插件的精简目录("Pengu Voice"),
 * 避免把整套换肤插件一起挂上去。
 */
import path from "node:path";
import { fileSize, isDirectory, isFile, copyFilePreserve, ensureDir, pathExists, removeQuietly, tryHardlink, createJunction, removeJunction } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";
import { writeAnsiFile, readTextAnyEncoding } from "../core/win/ansi.ts";
import type { GamePathResolution } from "../core/paths.ts";
import { VOICE_PLUGIN_NAME } from "../version.ts";

const logger = createLogger("pengu-loader");

export const LOADER_DIR_CANDIDATES = [
  "Pengu Loader",
  path.join("_internal", "Pengu Loader"),
  path.join("..", "Pengu Loader")
];

const LOADER_ROOT_FILES = ["core.dll", "d3d9_stub.dll", "Pengu Loader.exe", "Pengu Loader.exe.config"];
const STUB_NAME = "d3d9_stub.dll";
const PROXY_BACKUP_SUFFIX = ".chosen_bak";

export function roseConfigPath(): string {
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
  return path.join(localAppData, "Rose", "config.ini");
}

/** 定位 Pengu Loader 目录(必须含 core.dll 或 d3d9_stub.dll)。 */
export async function detectPenguLoaderDir(options: { configured?: string; appDir: string }): Promise<string | null> {
  const candidates: string[] = [];
  const env = (process.env.LEAGUE_VOICE_PENGU ?? "").trim();
  if (env) candidates.push(path.resolve(env));
  if (options.configured && options.configured.trim()) candidates.push(path.resolve(options.configured.trim()));
  for (const relative of LOADER_DIR_CANDIDATES) candidates.push(path.resolve(options.appDir, relative));
  candidates.push("E:\\ChosenSkin2.0\\Chosen\\Pengu Loader", "E:\\ChosenSkin2.0\\Chosen_VoiceMod\\Pengu Loader");

  for (const candidate of candidates) {
    if (!(await isDirectory(candidate))) continue;
    if ((await isFile(path.join(candidate, "core.dll"))) || (await isFile(path.join(candidate, STUB_NAME)))) {
      return candidate;
    }
  }
  logger.debug("未找到可用的 Pengu Loader 目录");
  return null;
}

export function stubPath(loaderDir: string): string {
  return path.join(loaderDir, STUB_NAME);
}

export function clientD3d9Path(resolution: GamePathResolution): string | null {
  return resolution.leagueDir ? path.join(resolution.leagueDir, "d3d9.dll") : null;
}

export interface StubStatus {
  active: boolean;
  target: string | null;
  stub: string | null;
  targetSize: number;
  stubSize: number;
  hasBackup: boolean;
  message: string;
}

/** 注入入口是否已就位(客户端 d3d9.dll 与加载桩同尺寸即视为已放置)。 */
export async function getStubStatus(loaderDir: string | null, resolution: GamePathResolution): Promise<StubStatus> {
  const target = clientD3d9Path(resolution);
  const stub = loaderDir ? stubPath(loaderDir) : null;
  const targetSize = target ? await fileSize(target) : 0;
  const stubSize = stub ? await fileSize(stub) : 0;
  const backup = target ? `${target}${PROXY_BACKUP_SUFFIX}` : null;
  const active = Boolean(target && stub && targetSize > 0 && stubSize > 0 && targetSize === stubSize);
  return {
    active,
    target,
    stub,
    targetSize,
    stubSize,
    hasBackup: backup ? await pathExists(backup) : false,
    message: active
      ? "加载桩已就位"
      : target && targetSize > 0
        ? "客户端 d3d9.dll 不是本工具的加载桩"
        : "尚未放置加载桩"
  };
}

export interface StubPlaceResult {
  ok: boolean;
  message: string;
  backedUp: boolean;
}

/** 放置加载桩(覆盖前先备份客户端原有的 d3d9.dll)。 */
export async function placeStub(loaderDir: string, resolution: GamePathResolution): Promise<StubPlaceResult> {
  const target = clientD3d9Path(resolution);
  if (!target) return { ok: false, message: "未找到联盟客户端目录，无法放置 d3d9 加载桩", backedUp: false };
  const stub = stubPath(loaderDir);
  if (!(await isFile(stub))) return { ok: false, message: `未找到加载桩文件：${stub}`, backedUp: false };

  const status = await getStubStatus(loaderDir, resolution);
  if (status.active) return { ok: true, message: "加载桩已就位", backedUp: false };

  let backedUp = false;
  if (await isFile(target)) {
    const backup = `${target}${PROXY_BACKUP_SUFFIX}`;
    if (!(await pathExists(backup))) {
      try {
        await copyFilePreserve(target, backup);
        backedUp = true;
      } catch (error) {
        return { ok: false, message: `备份客户端原有 d3d9.dll 失败：${String((error as Error).message ?? error)}`, backedUp: false };
      }
    }
  }

  // 同名覆盖: 先写到临时文件再改名, 避免留下半个 dll
  const temp = `${target}.chosen_new`;
  try {
    await removeQuietly(temp);
    await copyFilePreserve(stub, temp);
    const { rename } = await import("node:fs/promises");
    await rename(temp, target);
  } catch (error) {
    await removeQuietly(temp);
    return {
      ok: false,
      message: `放置加载桩失败：${String((error as Error).message ?? error)}（客户端正在运行时请先关闭）`,
      backedUp
    };
  }
  const verify = await getStubStatus(loaderDir, resolution);
  if (!verify.active) return { ok: false, message: "放置加载桩后校验未通过", backedUp };
  logger.info(`已放置 d3d9 加载桩 -> ${target}`);
  return { ok: true, message: "加载桩已就位", backedUp };
}

/** 移除加载桩, 并尽可能把客户端原有的 d3d9.dll 放回去。 */
export async function removeStub(resolution: GamePathResolution): Promise<{ ok: boolean; message: string }> {
  const target = clientD3d9Path(resolution);
  if (!target) return { ok: true, message: "未找到客户端目录，无需处理加载桩" };
  const backup = `${target}${PROXY_BACKUP_SUFFIX}`;
  const legacy = path.join(path.dirname(target), "d3d9.dll.old");
  let removed = 0;
  for (const file of [target, legacy]) {
    if (await isFile(file)) {
      if (await removeQuietly(file)) removed += 1;
    }
  }
  if (await isFile(backup)) {
    try {
      const { rename } = await import("node:fs/promises");
      await removeQuietly(target);
      await rename(backup, target);
      return { ok: true, message: "已移除加载桩并还原客户端原有 d3d9.dll" };
    } catch (error) {
      return { ok: false, message: `移除加载桩失败：${String((error as Error).message ?? error)}（客户端可能正在运行）` };
    }
  }
  return { ok: true, message: removed ? "已移除加载桩" : "加载桩不存在，无需处理" };
}

/** 只含语音插件的精简加载器目录。 */
export function voiceLoaderDir(loaderDir: string): string {
  return path.join(path.dirname(loaderDir), "Pengu Voice");
}

/** 准备精简加载器: 链接核心文件 + 把语音插件目录做成目录联接。 */
export async function ensureVoiceLoader(loaderDir: string, pluginDir: string): Promise<{ ok: boolean; dir: string; message: string }> {
  const target = voiceLoaderDir(loaderDir);
  if (!(await ensureDir(target))) return { ok: false, dir: target, message: `无法创建加载器目录：${target}` };
  for (const name of LOADER_ROOT_FILES) {
    const src = path.join(loaderDir, name);
    const dst = path.join(target, name);
    if ((await pathExists(dst)) || !(await isFile(src))) continue;
    if (await tryHardlink(src, dst)) continue;
    try {
      await copyFilePreserve(src, dst);
    } catch (error) {
      logger.warn(`链接加载器文件失败 ${name}: ${String((error as Error).message ?? error)}`);
    }
  }
  const pluginLink = path.join(target, "plugins", VOICE_PLUGIN_NAME);
  if (!(await isDirectory(pluginLink))) {
    const [linked, why] = await createJunction(pluginLink, pluginDir);
    if (!linked) return { ok: false, dir: target, message: why };
  }
  return { ok: true, dir: target, message: "" };
}

export interface LoaderIniState {
  disabled: boolean;
  loaderPath: string;
  text: string;
}

/** 读取 Rose 配置(可能不存在)。 */
export async function readLoaderIni(): Promise<LoaderIniState> {
  const file = roseConfigPath();
  const text = (await readTextAnyEncoding(file)) ?? "";
  const disabledMatch = /disabled\s*=\s*(\d+)/i.exec(text);
  const pathMatch = /loaderpath\s*=\s*(.*)/i.exec(text);
  return {
    disabled: disabledMatch ? disabledMatch[1] !== "0" : !text,
    loaderPath: pathMatch ? pathMatch[1]!.trim() : "",
    text
  };
}

/** 写入 Rose 配置(路径含中文时按 ANSI 写, 避免加载器读成乱码)。 */
export async function writeLoaderIni(enabled: boolean, loaderDir: string): Promise<[boolean, string]> {
  const file = roseConfigPath();
  const content = enabled ? `[General]\ndisabled=0\nloaderpath=${loaderDir}\n` : "[General]\ndisabled=1\nloaderpath=\n";
  const [ok, why] = await writeAnsiFile(file, content, 936);
  if (!ok) return [false, `写入加载器配置失败：${why}`];
  logger.info(`Rose 配置已更新: enabled=${enabled} loader=${enabled ? loaderDir : "(空)"}`);
  return [true, ""];
}

/** 移除目录联接(供还原流程复用)。 */
export async function unmountJunction(link: string): Promise<boolean> {
  return removeJunction(link);
}
