/** Windows 进程探测: 对局/客户端是否在跑、客户端安装目录、LCU 凭据。 */
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

/** 从 UX 进程命令行解析 LCU 端口与 token。 */
export async function lcuCredentials(): Promise<LcuCredentials | null> {
  const items = await processSnapshot(true);
  const candidates = items.filter((item) => item.name.toLowerCase() === CLIENT_UX_EXE.toLowerCase());
  for (const proc of candidates) {
    let appPort = "";
    let remoting = "";
    let riotPort = "";
    let riotToken = "";
    for (const arg of proc.commandLine.split(/\s+/)) {
      if (arg.startsWith("--app-port=")) appPort = arg.slice("--app-port=".length).trim();
      else if (arg.startsWith("--remoting-auth-token=")) remoting = arg.slice("--remoting-auth-token=".length).trim();
      else if (arg.startsWith("--riotclient-app-port=")) riotPort = arg.slice("--riotclient-app-port=".length).trim();
      else if (arg.startsWith("--riotclient-auth-token=")) riotToken = arg.slice("--riotclient-auth-token=".length).trim();
    }
    if (appPort && remoting) return { port: appPort, token: remoting, source: "app-port" };
    if (riotPort && riotToken) return { port: riotPort, token: riotToken, source: "riotclient-app-port" };
  }
  return null;
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
  return { ok, message: results.join(", ") };
}
