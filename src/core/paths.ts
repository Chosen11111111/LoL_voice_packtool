/**
 * 游戏路径解析 —— 开启/还原/状态查询共用同一次解析结果, 绝不"每次各猜一次"。
 *
 * 解析优先级:
 *   1. 配置或环境变量里显式给出的联盟客户端目录
 *   2. 正在运行的 LeagueClientUx.exe 的真实路径(权威)
 *   3. 注册表 / Riot 产品元数据 / 常见安装目录扫描
 * 若 1 与 2 同时存在且不是同一份安装, 直接报冲突并停止, 避免改错目录。
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { ensureDir, isDirectory, isFile, readTextFile, listNames } from "./fsx.ts";
import { createLogger } from "./logger.ts";
import { regQueryValue } from "./win/registry.ts";
import { findClientExeDir } from "./win/processes.ts";
import { appRoot, type AppConfig } from "./config.ts";

const logger = createLogger("paths");

export const LEAGUE_CLIENT_EXE = "LeagueClient.exe";
export const LEAGUE_UX_EXE = "LeagueClientUx.exe";
export const LEAGUE_GAME_EXE = "League of Legends.exe";

export type PathSource = "config" | "env" | "process" | "registry" | "metadata" | "scan" | "none";

export interface GamePathResolution {
  ok: boolean;
  finalDir: string | null;
  gameDir: string | null;
  leagueDir: string;
  configuredDir: string;
  runningDir: string;
  source: PathSource;
  sourceDetail: string;
  mismatch: boolean;
  message: string;
}

export interface PathCandidate {
  path: string;
  source: PathSource;
  sourceDetail: string;
  hasClient: boolean;
  leagueDir: string | null;
  gameDir: string | null;
  finalDir: string | null;
}

/* ------------------------------------------------------------------ 基础判定 */

export function normalizeForCompare(input: string): string {
  let text = String(input ?? "").trim().replace(/^"|"$/g, "");
  if (!text) return "";
  text = path.resolve(text).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? text.toLowerCase() : text;
}

export function pathsEquivalent(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normalizeForCompare(left ?? "");
  const b = normalizeForCompare(right ?? "");
  return Boolean(a) && a === b;
}

export async function isValidLeagueDir(dir: string | null | undefined): Promise<boolean> {
  if (!dir) return false;
  return (await isFile(path.join(dir, LEAGUE_CLIENT_EXE))) || (await isFile(path.join(dir, LEAGUE_UX_EXE)));
}

/** 把用户给的路径归一化成客户端目录(自身/固定子目录/一级子目录扫描)。 */
export async function normalizeLeagueDir(input: string | null | undefined): Promise<string | null> {
  const raw = String(input ?? "").trim().replace(/^"|"$/g, "");
  if (!raw) return null;
  if (await isValidLeagueDir(raw)) return path.resolve(raw);

  const fixed = path.join(raw, "LeagueClient");
  if (await isValidLeagueDir(fixed)) return path.resolve(fixed);

  // 只扫描所选目录的直接子目录(兼容网吧自定义目录名), 不向父级扩张
  try {
    for (const name of await listNames(raw)) {
      const child = path.join(raw, name);
      if (await isDirectory(child)) {
        if (await isValidLeagueDir(child)) return path.resolve(child);
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 由客户端目录推导游戏本体目录(League of Legends.exe 所在目录)。 */
export async function findGameDir(leagueDir: string | null | undefined): Promise<string | null> {
  if (!leagueDir) return null;
  const normalized = path.resolve(leagueDir).replace(/[\\/]+$/, "");
  const parent = path.dirname(normalized);
  const candidates = [path.join(normalized, "Game"), normalized, path.join(parent, "Game")];
  for (const candidate of candidates) {
    if (await isFile(path.join(candidate, LEAGUE_GAME_EXE))) return candidate;
  }
  return null;
}

/** 游戏目录与客户端目录是否属于同一份安装(WeGame 与 Riot 两种布局都要成立)。 */
export function gameBelongsToLeague(gameDir: string, leagueDir: string): boolean {
  const gameParent = path.dirname(path.resolve(gameDir));
  const league = path.resolve(leagueDir);
  return (
    pathsEquivalent(gameParent, league) || pathsEquivalent(gameParent, path.dirname(league))
  );
}

/* ------------------------------------------------------------------ 自动探测 */

async function detectFromRegistry(): Promise<{ dir: string; detail: string } | null> {
  const checks: Array<{ key: string; value: string; view?: "32" | "64"; label: string }> = [
    { key: "HKCU\\Software\\Tencent\\LOL", value: "InstallPath", label: "HKCU\\Software\\Tencent\\LOL" },
    { key: "HKLM\\SOFTWARE\\Tencent\\LOL", value: "InstallPath", view: "64", label: "HKLM\\SOFTWARE\\Tencent\\LOL" },
    {
      key: "HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\LOL",
      value: "InstallPath",
      view: "32",
      label: "HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\LOL"
    },
    {
      key: "HKLM\\SOFTWARE\\WOW6432Node\\Riot Games, Inc\\League of Legends",
      value: "InstallLocation",
      view: "32",
      label: "HKLM\\...\\Riot Games, Inc\\League of Legends"
    },
    {
      key: "HKLM\\SOFTWARE\\Riot Games, Inc\\League of Legends",
      value: "InstallLocation",
      view: "64",
      label: "HKLM\\SOFTWARE\\Riot Games, Inc\\League of Legends"
    }
  ];
  for (const check of checks) {
    const value = await regQueryValue(check.key, check.value, check.view);
    if (!value) continue;
    const normalized = await normalizeLeagueDir(value);
    if (normalized) return { dir: normalized, detail: `注册表 ${check.label}` };
    logger.debug(`注册表 ${check.label} 值无效: ${value}`);
  }
  return null;
}

async function detectFromRiotMetadata(): Promise<{ dir: string; detail: string } | null> {
  const programData = process.env.ProgramData || "C:\\ProgramData";
  const metadata = path.join(
    programData,
    "Riot Games",
    "Metadata",
    "league_of_legends.live",
    "league_of_legends.live.product_settings.yaml"
  );
  const text = await readTextFile(metadata);
  if (!text) return null;
  const match = /product_install_full_path:\s*(.+)/.exec(text);
  if (!match) return null;
  const raw = match[1]!.trim().replace(/^["']|["']$/g, "");
  const normalized = await normalizeLeagueDir(raw);
  if (normalized) return { dir: normalized, detail: "Riot 产品元数据" };
  return null;
}

async function detectFromCommonRoots(): Promise<{ dir: string; detail: string } | null> {
  const drives = ["C:", "D:", "E:", "F:", "G:"];
  const roots: string[] = [];
  const candidates = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env["SystemDrive"]]
    .filter((item): item is string => Boolean(item))
    .map((item) => (item.endsWith(":") ? `${item}\\` : item));
  for (const base of candidates) {
    roots.push(path.join(base, "WeGameApps"));
    roots.push(path.join(base, "Riot Games"));
  }
  for (const drive of drives) {
    roots.push(`${drive}\\WeGameApps`);
    roots.push(`${drive}\\Riot Games`);
  }
  roots.push(path.join(os.homedir(), "AppData", "Local", "Riot Games"));

  const seen = new Set<string>();
  for (const root of roots) {
    const key = normalizeForCompare(root);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(await isDirectory(root))) continue;
    const children = [path.join(root, "League of Legends"), path.join(root, "英雄联盟")];
    for (const name of await listNames(root)) children.push(path.join(root, name));
    for (const child of children) {
      if (!(await isDirectory(child))) continue;
      const normalized = await normalizeLeagueDir(child);
      if (normalized) return { dir: normalized, detail: `目录扫描 ${child}` };
    }
  }
  return null;
}

/** 列出所有能定位到的客户端目录(诊断/前端选择用)。 */
export async function detectCandidates(): Promise<PathCandidate[]> {
  const found: PathCandidate[] = [];
  const push = async (raw: string | null, source: PathSource, detail: string) => {
    if (!raw) return;
    const leagueDir = await normalizeLeagueDir(raw);
    const hasClient = Boolean(leagueDir);
    const gameDir = leagueDir ? await findGameDir(leagueDir) : null;
    const finalDir = gameDir ? path.join(gameDir, "DATA", "FINAL") : null;
    const payload: PathCandidate = {
      path: raw,
      source,
      sourceDetail: detail,
      hasClient,
      leagueDir,
      gameDir: gameDir ?? null,
      finalDir: finalDir && (await isDirectory(finalDir)) ? finalDir : null
    };
    if (found.some((item) => pathsEquivalent(item.leagueDir ?? item.path, payload.leagueDir ?? payload.path))) return;
    found.push(payload);
  };

  await push(process.env.LEAGUE_PATH ?? null, "env", "环境变量 LEAGUE_PATH");
  const running = await findClientExeDir();
  await push(running, "process", "运行中的 LeagueClientUx.exe");
  const registry = await detectFromRegistry();
  await push(registry?.dir ?? null, "registry", registry?.detail ?? "");
  const metadata = await detectFromRiotMetadata();
  await push(metadata?.dir ?? null, "metadata", metadata?.detail ?? "");
  const scan = await detectFromCommonRoots();
  await push(scan?.dir ?? null, "scan", scan?.detail ?? "");
  return found;
}

/* ------------------------------------------------------------------ 统一解析 */

export interface ResolveOptions {
  /** 配置里显式指定的客户端目录。 */
  leaguePath?: string;
  /** 配置里显式指定的游戏目录。 */
  gamePath?: string;
  /** 跳过运行中进程探测(测试/离线场景)。 */
  skipProcess?: boolean;
  /** 跳过注册表与磁盘扫描(测试场景)。 */
  skipAutoDetect?: boolean;
}

export async function resolveGamePaths(options: ResolveOptions = {}): Promise<GamePathResolution> {
  const empty: GamePathResolution = {
    ok: false,
    finalDir: null,
    gameDir: null,
    leagueDir: "",
    configuredDir: "",
    runningDir: "",
    source: "none",
    sourceDetail: "",
    mismatch: false,
    message: ""
  };

  const envPath = (process.env.LEAGUE_PATH ?? "").trim();
  const configuredRaw = (options.leaguePath ?? "").trim() || envPath;
  const configuredSource: PathSource = (options.leaguePath ?? "").trim() ? "config" : envPath ? "env" : "none";
  const configuredDir = configuredRaw ? await normalizeLeagueDir(configuredRaw) : null;
  const runningDir = options.skipProcess ? null : await normalizeLeagueDir(await findClientExeDir());

  if (configuredDir && runningDir && !pathsEquivalent(configuredDir, runningDir)) {
    const message = [
      "配置中的联盟路径与正在运行的客户端不是同一份安装，已停止切换以免改错目录。",
      `配置路径：${configuredDir}`,
      `运行客户端：${runningDir}`,
      "请关闭客户端后重试，或把配置里的联盟路径改成当前运行的客户端。"
    ].join("\n");
    logger.warn(`路径冲突 configured=${configuredDir} running=${runningDir}`);
    return { ...empty, configuredDir: configuredDir, runningDir, source: configuredSource, mismatch: true, message };
  }

  let leagueDir: string | null = configuredDir ?? runningDir;
  let source: PathSource = configuredDir ? configuredSource : runningDir ? "process" : "none";
  let sourceDetail = configuredDir ? (configuredSource === "env" ? "环境变量 LEAGUE_PATH" : "配置文件") : runningDir ? "运行中的客户端进程" : "";

  if (!leagueDir && !options.skipAutoDetect) {
    const registry = await detectFromRegistry();
    if (registry) {
      leagueDir = registry.dir;
      source = "registry";
      sourceDetail = registry.detail;
    } else {
      const metadata = await detectFromRiotMetadata();
      if (metadata) {
        leagueDir = metadata.dir;
        source = "metadata";
        sourceDetail = metadata.detail;
      } else {
        const scan = await detectFromCommonRoots();
        if (scan) {
          leagueDir = scan.dir;
          source = "scan";
          sourceDetail = scan.detail;
        }
      }
    }
  }

  if (!leagueDir) {
    const message = configuredRaw
      ? `无法把配置里的路径解析成联盟客户端目录：${configuredRaw}\n该目录下应当能找到 LeagueClient.exe。`
      : "未能自动定位英雄联盟客户端，请在配置里指定联盟客户端目录（含 LeagueClient.exe）。";
    logger.warn(`未能定位客户端 configured=${configuredRaw} running=${runningDir ?? ""}`);
    return { ...empty, configuredDir: configuredRaw, runningDir: runningDir ?? "", source, sourceDetail, message };
  }

  const running = runningDir ?? "";
  const configured = configuredDir ?? "";

  let gameDir: string | null = null;
  const configuredGame = (options.gamePath ?? "").trim();
  if (configuredGame && (await isFile(path.join(configuredGame, LEAGUE_GAME_EXE)))) {
    if (gameBelongsToLeague(configuredGame, leagueDir)) {
      gameDir = path.resolve(configuredGame);
    } else {
      const message = [
        "配置里的游戏目录与联盟客户端不属于同一份安装，已停止切换以免改错目录。",
        `客户端路径：${leagueDir}`,
        `游戏目录：${configuredGame}`,
        "请把配置里的联盟路径重新指向正确的安装。"
      ].join("\n");
      logger.warn(`游戏目录冲突 league=${leagueDir} game=${configuredGame}`);
      return {
        ...empty,
        gameDir: path.resolve(configuredGame),
        leagueDir,
        configuredDir: configured,
        runningDir: running,
        source,
        sourceDetail,
        mismatch: true,
        message
      };
    }
  }
  if (!gameDir) gameDir = await findGameDir(leagueDir);

  if (!gameDir) {
    const message = [
      `未能从联盟客户端路径定位游戏本体目录：${leagueDir}`,
      "请确认配置的路径下同时存在 LeagueClient 与 Game 目录。"
    ].join("\n");
    logger.warn(`未找到游戏目录 league=${leagueDir}`);
    return {
      ...empty,
      leagueDir,
      configuredDir: configured,
      runningDir: running,
      source,
      sourceDetail,
      message
    };
  }

  const finalDir = path.join(gameDir, "DATA", "FINAL");
  if (!(await isDirectory(finalDir))) {
    const message = [
      `未找到游戏文件目录 Game\\DATA\\FINAL：${finalDir}`,
      "请在配置里指向正确的英雄联盟安装后重试。"
    ].join("\n");
    logger.warn(`未找到 FINAL 目录 final=${finalDir}`);
    return {
      ...empty,
      gameDir,
      leagueDir,
      configuredDir: configured,
      runningDir: running,
      source,
      sourceDetail,
      message
    };
  }

  logger.debug(`路径解析成功 final=${finalDir} league=${leagueDir} source=${source}`);
  return {
    ok: true,
    finalDir,
    gameDir,
    leagueDir,
    configuredDir: configured,
    runningDir: running,
    source,
    sourceDetail,
    mismatch: false,
    message: `游戏文件目录：${finalDir}`
  };
}

export async function leagueClientDir(resolution: GamePathResolution): Promise<string | null> {
  if (!resolution.leagueDir) return null;
  return (await isDirectory(resolution.leagueDir)) ? resolution.leagueDir : null;
}

/** 只匹配独立 locale 项，跳过注释、other_locale 等键，兼容引号和 CRLF。 */
export const CLIENT_LOCALE_PATTERN = /^([\t \uFEFF]*locale:[\t ]*)(?:"([a-z]{2}_[A-Z]{2})"|'([a-z]{2}_[A-Z]{2})'|([a-z]{2}_[A-Z]{2}))(?=[\t ]*(?:#[^\r\n]*)?\r?$)/m;

export function readClientLocale(text: string): string | null {
  const match = CLIENT_LOCALE_PATTERN.exec(text);
  return match ? match[2] ?? match[3] ?? match[4] ?? null : null;
}

export async function settingsYamlPath(resolution: Pick<GamePathResolution, "leagueDir">): Promise<string | null> {
  const client = resolution.leagueDir;
  if (!client || !(await isDirectory(client))) return null;
  const candidates = [
    path.join(client, "Config", "LeagueClientSettings.yaml"),
    path.join(client, "LeagueClient", "Config", "LeagueClientSettings.yaml")
  ];
  for (const file of candidates) if (await isFile(file)) return file;
  return candidates[0]!;
}

/* ------------------------------------------------------------------ 资源根目录 */

export type VoiceRootSource = "env" | "config" | "appdir" | "sibling" | "parent";

export interface VoiceRootResolution {
  root: string;
  source: VoiceRootSource;
  candidates: string[];
  hasPacks: boolean;
}

const LOCALE_DIR_PATTERN = /^[a-z]{2}_[A-Z]{2}$/;

async function looksLikePackRoot(dir: string): Promise<boolean> {
  if (!(await isDirectory(dir))) return false;
  for (const name of await listNames(dir)) {
    if (LOCALE_DIR_PATTERN.test(name) && (await isDirectory(path.join(dir, name)))) return true;
  }
  return false;
}

/**
 * 语音包资源根目录。
 *
 * 默认就是**软件自己的目录**下的 `language\`: 换台电脑、换个安装位置都不用改任何东西,
 * 解压/识别/播报全都认这一处(不会再去猜别的路径, 也不再写死任何绝对路径)。
 *
 * 只有显式指定才另算: 环境变量 LEAGUE_VOICE_ROOT > config.json 的 voiceRoot。
 */
export async function resolveVoiceRoot(
  config: Pick<AppConfig, "voiceRoot">,
  appDir = appRoot()
): Promise<VoiceRootResolution> {
  const defaultRoot = path.join(appDir, "language");
  const candidates: Array<{ dir: string; source: VoiceRootSource }> = [
    { dir: defaultRoot, source: "appdir" },
    { dir: path.join(appDir, "voice"), source: "appdir" },
    { dir: path.resolve(appDir, ".."), source: "sibling" },
    { dir: path.resolve(appDir, "..", "voice"), source: "parent" }
  ];

  const env = (process.env.LEAGUE_VOICE_ROOT ?? "").trim();
  const explicit = env || (config.voiceRoot ?? "").trim();
  if (explicit) {
    const dir = path.resolve(explicit);
    await ensureDir(dir);
    return {
      root: dir,
      source: env ? "env" : "config",
      candidates: [dir, ...candidates.map((item) => item.dir)],
      hasPacks: await looksLikePackRoot(dir)
    };
  }

  // 旧位置的语音包同步进来(作者机器上那个"素材库"更新完, 启动工具就能用上)
  await syncFromLegacy(defaultRoot, candidates.slice(1).map((item) => item.dir));
  await ensureDir(defaultRoot);
  return {
    root: defaultRoot,
    source: "appdir",
    candidates: candidates.map((item) => item.dir),
    hasPacks: await looksLikePackRoot(defaultRoot)
  };
}

/**
 * 旧位置的语音包同步进默认目录(`<软件目录>\language`)。
 *
 * 定位: 旧位置(比如作者自己用来更新素材的那个目录)是"素材库", `language\` 是工具的工作目录。
 * 规则很简单 —— **按文件时间, 素材库里的更新(更大/更新的文件)覆盖工作目录里的同名文件;
 * 工作目录里多出来的文件保留**。所以两边各留一份, 用户更新完启动工具就能用上。
 *
 * 同盘用**硬链接**(瞬间完成、不占额外空间); 跨盘退化成复制。源目录绝不改动、绝不删除。
 */
async function syncFromLegacy(target: string, sources: string[]): Promise<void> {
  let linked = 0;
  let replaced = 0;
  let failed = 0;
  for (const source of sources) {
    if (path.resolve(source) === path.resolve(target)) continue;
    if (!(await isDirectory(source))) continue;
    for (const name of await listNames(source)) {
      if (!LOCALE_DIR_PATTERN.test(name)) continue;
      const from = path.join(source, name);
      if (!(await isDirectory(from))) continue;
      await ensureDir(target);
      const counters = await mirrorTree(from, path.join(target, name));
      linked += counters.linked;
      replaced += counters.replaced;
      failed += counters.failed;
    }
  }
  if (linked || replaced || failed) {
    logger.info(
      `旧位置语音包已同步进软件目录: 新增 ${linked} 个文件, 更新 ${replaced} 个` + (failed ? `, 失败 ${failed} 个` : "")
    );
  }
}

interface MirrorCounters {
  linked: number;
  replaced: number;
  failed: number;
}

/** 把 from 目录镜像到 to: 缺失的补上, 更新的覆盖(更大或更新的文件)。 */
async function mirrorTree(from: string, to: string): Promise<MirrorCounters> {
  const counters: MirrorCounters = { linked: 0, replaced: 0, failed: 0 };
  const entries = await fs.readdir(from, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      const nested = await mirrorTree(src, dst);
      counters.linked += nested.linked;
      counters.replaced += nested.replaced;
      counters.failed += nested.failed;
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const sourceInfo = await fs.stat(src);
      const targetInfo = await fs.stat(dst).catch(() => null);
      const stale = Boolean(targetInfo) && (targetInfo!.size !== sourceInfo.size || sourceInfo.mtimeMs > targetInfo!.mtimeMs + 1000);
      if (targetInfo && !stale) continue;
      await ensureDir(path.dirname(dst));
      if (targetInfo) await fs.rm(dst, { force: true });
      try {
        await fs.link(src, dst);
      } catch {
        await fs.copyFile(src, dst);
      }
      if (targetInfo) counters.replaced += 1;
      else counters.linked += 1;
    } catch (error) {
      counters.failed += 1;
      logger.debug(`同步语音包文件失败: ${src} —— ${String((error as Error).message ?? error)}`);
    }
  }
  return counters;
}
