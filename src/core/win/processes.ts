/** Windows 进程探测: 对局/客户端是否在跑、客户端安装目录、LCU 凭据。 */
import fs from "node:fs/promises";
import path from "node:path";
import { run, runPowerShell } from "./shell.ts";
import { log } from "../logger.ts";

const logger = log.child("processes");

export const GAME_EXE = "League of Legends.exe";
export const CLIENT_UX_EXE = "LeagueClientUx.exe";
export const CLIENT_EXES = ["LeagueClientUx.exe", "LeagueClient.exe", "LeagueClientUxRender.exe"] as const;

export interface ProcessInfo {
  pid: number;
  name: string;
  exePath: string;
  commandLine: string;
}

export interface LcuCredentials {
  port: string;
  token: string;
  source: "app-port" | "riotclient-app-port";
}

let snapshotCache: { at: number; items: ProcessInfo[] } | null = null;
const SNAPSHOT_TTL_MS = 2000;

export function clearProcessCache(): void {
  snapshotCache = null;
}

function parseSnapshot(stdout: string): ProcessInfo[] {
  const text = stdout.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger.debug("进程快照 JSON 解析失败");
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const items: ProcessInfo[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const name = String(record.Name ?? "");
    if (!name) continue;
    items.push({
      pid: Number(record.ProcessId ?? 0),
      name,
      exePath: String(record.ExecutablePath ?? ""),
      commandLine: String(record.CommandLine ?? "")
    });
  }
  return items;
}

/** 取一次英雄联盟相关进程快照(带 2 秒缓存, 避免频繁拉起 WMI)。 */
export async function processSnapshot(force = false): Promise<ProcessInfo[]> {
  if (!force && snapshotCache && Date.now() - snapshotCache.at < SNAPSHOT_TTL_MS) {
    return snapshotCache.items;
  }
  const filter = CLIENT_EXES.map((name) => `Name='${name}'`).concat(`Name='${GAME_EXE}'`).join(" or ");
  const script = `@(Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,Name,ExecutablePath,CommandLine) | ConvertTo-Json -Compress -Depth 3`;
  const result = await runPowerShell(script, { timeoutMs: 20000 });
  const items = result.ok || result.stdout ? parseSnapshot(result.stdout) : [];
  if (!items.length && !result.ok) {
    logger.debug(`进程快照不可用: code=${result.code} err=${result.error}`);
  }
  snapshotCache = { at: Date.now(), items };
  return items;
}

/** 用 tasklist 做轻量存在性判断(比 WMI 快一个数量级)。 */
export async function isProcessRunning(exeName: string): Promise<boolean> {
  const result = await run("tasklist", ["/FI", `IMAGENAME eq ${exeName}`, "/NH"], { timeoutMs: 10000 });
  if (result.outputUnavailable) {
    // 管道被拒: 用快照兜底
    const items = await processSnapshot();
    return items.some((item) => item.name.toLowerCase() === exeName.toLowerCase());
  }
  return result.stdout.toLowerCase().includes(exeName.toLowerCase());
}

/** 对局进程是否在跑(对局中切换会被游戏锁定)。 */
export async function isGameRunning(): Promise<boolean> {
  return isProcessRunning(GAME_EXE);
}

/** 大厅客户端是否在跑。 */
export async function isClientRunning(): Promise<boolean> {
  for (const exe of CLIENT_EXES) {
    if (await isProcessRunning(exe)) return true;
  }
  return false;
}

/** 找到正在运行的 UX 进程(带可执行路径与命令行)。 */
export async function findClientProcess(): Promise<ProcessInfo | null> {
  const items = await processSnapshot();
  const ux = items.find((item) => item.name.toLowerCase() === CLIENT_UX_EXE.toLowerCase() && item.exePath);
  if (ux) return ux;
  return items.find((item) => CLIENT_EXES.some((exe) => exe.toLowerCase() === item.name.toLowerCase()) && item.exePath) ?? null;
}

/** 运行中客户端所在目录(权威来源, 优先于任何配置)。 */
export async function findClientExeDir(): Promise<string | null> {
  const proc = await findClientProcess();
  if (!proc || !proc.exePath) return null;
  const dir = proc.exePath.replace(/[\\/][^\\/]*$/, "");
  return dir || null;
}

/** 从一段命令行文本里解析 LCU 连接信息(导出便于测试)。 */
export function parseLcuCommandLine(commandLine: string): LcuCredentials | null {
  let appPort = "";
  let remoting = "";
  let riotPort = "";
  let riotToken = "";
  for (const arg of commandLine.split(/\s+/)) {
    if (arg.startsWith("--app-port=")) appPort = arg.slice("--app-port=".length).trim();
    else if (arg.startsWith("--remoting-auth-token=")) remoting = arg.slice("--remoting-auth-token=".length).trim();
    else if (arg.startsWith("--riotclient-app-port=")) riotPort = arg.slice("--riotclient-app-port=".length).trim();
    else if (arg.startsWith("--riotclient-auth-token=")) riotToken = arg.slice("--riotclient-auth-token=".length).trim();
  }
  if (appPort && remoting) return { port: appPort, token: remoting, source: "app-port" };
  // 国服(WeGame/TENCENT)没有 --app-port/--remoting-auth-token, LCU 复用 riotclient 的端口与令牌
  if (riotPort && riotToken) return { port: riotPort, token: riotToken, source: "riotclient-app-port" };
  return null;
}

/**
 * 从客户端自己的日志里取 LCU 连接信息。
 *
 * 为什么需要这条路: 国服客户端由 WeGame 以管理员权限启动, 且被 ACE 反作弊(ACE-BASE.sys 内核驱动)
 * 保护 —— 即使本工具提权, 也读不到 LeagueClientUx.exe 的命令行。
 * 但客户端启动时会把命令行原样写进自己的日志第一行, 例如:
 *   Command line arguments: --app-port=61193 --remoting-auth-token=… --riotclient-app-port=60990 …
 * 于是"读日志"就成了既不需要提权、也不碰反作弊的可靠来源。
 */
/** 先看的目录: 运行中客户端(拿得到时) + 配置里那台。 */
async function fastCredentialRoots(): Promise<string[]> {
  const roots = new Set<string>();
  const running = await findClientExeDir();
  if (running) roots.add(running);
  if (clientDirFromConfig) roots.add(clientDirFromConfig);
  return [...roots];
}

/** 收集这些安装目录下的客户端日志(含 Game/Logs/LeagueClient Logs)。 */
async function collectClientLogs(dirs: Array<string | null>): Promise<Array<{ file: string; at: number }>> {
  const found: Array<{ file: string; at: number }> = [];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const folder of [dir, path.join(dir, "..", "Game", "Logs", "LeagueClient Logs")]) {
      let names: string[] = [];
      try {
        names = await fs.readdir(folder);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!/LeagueClient(Ux)?\.log$/i.test(name)) continue;
        const file = path.join(folder, name);
        try {
          const info = await fs.stat(file);
          found.push({ file, at: info.mtimeMs });
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  return found;
}

/** 安装目录探测很重(注册表 + 常见目录 + 扫描), 缓存一段时间复用。 */
let installDirCache: { at: number; dirs: string[] } | null = null;
const INSTALL_DIR_TTL_MS = 5 * 60 * 1000;

async function detectInstallDirs(): Promise<string[]> {
  if (installDirCache && Date.now() - installDirCache.at < INSTALL_DIR_TTL_MS) return installDirCache.dirs;
  const { detectCandidates } = await import("../paths.ts");
  const dirs: string[] = [];
  for (const candidate of await detectCandidates()) {
    if (candidate.leagueDir) dirs.push(candidate.leagueDir);
  }
  installDirCache = { at: Date.now(), dirs };
  if (dirs.length) logger.debug(`发现 ${dirs.length} 个客户端安装: ${dirs.join(" | ")}`);
  return dirs;
}

async function credentialsFromLogs(): Promise<LcuCredentials | null> {
  // 快路径: 配置/运行目录里有没有"正在写"的日志(客户端运行时会持续写日志)
  const FRESH_MS = 10 * 60 * 1000;
  let candidates = await collectClientLogs(await fastCredentialRoots());
  candidates.sort((a, b) => b.at - a.at);
  let usable = candidates.filter((item) => Date.now() - item.at < FRESH_MS);
  if (!usable.length) {
    // 慢路径: 配置里那台其实没在跑(例如配置指向国际服、真正在跑的是国服) —— 扫一遍其它安装
    try {
      const other = await collectClientLogs(await detectInstallDirs());
      candidates = [...candidates, ...other].sort((a, b) => b.at - a.at);
      usable = candidates.filter((item) => Date.now() - item.at < FRESH_MS);
    } catch (error) {
      logger.debug(`兜底安装探测失败: ${String((error as Error).message ?? error)}`);
    }
  }
  // 没有任何"新鲜"日志时也试一把最新的(可能刚启动/时钟差异), 交给上层用失败结果判断
  const ordered = (usable.length ? usable : candidates).slice(0, 4);

  for (const candidate of ordered) {
    let head = "";
    try {
      // 命令行在第一行, 只读前 32KB 就够(日志可能上百 MB)
      const handle = await fs.open(candidate.file, "r");
      try {
        const buffer = Buffer.alloc(32 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        head = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }
    const parsed = parseLcuCommandLine(head);
    if (parsed) {
      logger.debug(`LCU 凭据来自日志 ${path.basename(candidate.file)}（${parsed.source}）`);
      return parsed;
    }
  }
  return null;
}

/** 由配置指定的客户端目录(日志回退时用, 因为受保护进程拿不到路径)。 */
export function setClientDirHint(dir: string | null): void {
  clientDirFromConfig = dir ? path.resolve(dir) : null;
}

let clientDirFromConfig: string | null = null;

/** 缓存: 进程命令行读不到时改读日志, 但不必每次轮询都读盘。 */
let credentialCache: { at: number; value: LcuCredentials | null } | null = null;
const CREDENTIAL_TTL_MS = 20000;

/** 清空 LCU 凭据缓存(客户端重启后调用)。 */
export function clearCredentialCache(): void {
  credentialCache = null;
}

/** LCU 端口与 token: 先读进程命令行(国际服), 失败则读客户端日志(国服)。 */
export async function lcuCredentials(force = false): Promise<LcuCredentials | null> {
  if (!force && credentialCache && Date.now() - credentialCache.at < CREDENTIAL_TTL_MS) {
    return credentialCache.value;
  }
  let value: LcuCredentials | null = null;
  const items = await processSnapshot(true);
  for (const proc of items) {
    if (proc.name.toLowerCase() !== CLIENT_UX_EXE.toLowerCase()) continue;
    value = parseLcuCommandLine(proc.commandLine);
    if (value) break;
  }
  if (!value) value = await credentialsFromLogs();
  credentialCache = { at: Date.now(), value };
  return value;
}

/** 结束客户端 UX(以及渲染进程), 由 LeagueClient.exe 的看门狗自动拉起新的干净 UX。 */
export async function killClientUx(): Promise<{ ok: boolean; message: string }> {
  const results: string[] = [];
  let ok = false;
  for (const exe of ["LeagueClientUx.exe", "LeagueClientUxRender.exe"]) {
    const result = await run("taskkill", ["/F", "/IM", exe], { timeoutMs: 15000 });
    const combined = `${result.stdout}${result.stderr}`;
    if (result.ok || /not found|没有找到|不存在/i.test(combined)) ok = true;
    results.push(`${exe}: code=${result.code ?? "null"}`);
  }
  clearProcessCache();
  clearCredentialCache();
  return { ok, message: results.join(", ") };
}
