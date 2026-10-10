/** 极简分级日志: 控制台 + 可选落盘(逐行 UTF-8)。 */
import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let currentLevel: LogLevel = (process.env.LEAGUE_VOICE_LOG_LEVEL as LogLevel) || "info";
let logFilePath: string | null = null;
let logStream: fs.WriteStream | null = null;

export function setLogLevel(level: LogLevel): void {
  if (ORDER[level] !== undefined) currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** 把日志同时写入文件(重复调用会切换文件)。 */
export function setLogFile(file: string | null): void {
  try {
    logStream?.end();
  } catch {
    /* ignore */
  }
  logStream = null;
  logFilePath = null;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    logStream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
    logFilePath = file;
  } catch {
    logStream = null;
  }
}

export function getLogFile(): string | null {
  return logFilePath;
}

function ts(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export interface Logger {
  debug(msg: string, ...rest: unknown[]): void;
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
  child(scope: string): Logger;
}

function formatArgs(rest: unknown[]): string {
  if (!rest.length) return "";
  return (
    " " +
    rest
      .map((item) => {
        if (typeof item === "string") return item;
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      })
      .join(" ")
  );
}

export function createLogger(scope = "app"): Logger {
  const emit = (level: Exclude<LogLevel, "silent">, msg: string, rest: unknown[]) => {
    if (ORDER[level] < ORDER[currentLevel]) return;
    const line = `${ts()} [${level.toUpperCase().padEnd(5)}] [${scope}] ${msg}${formatArgs(rest)}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    try {
      logStream?.write(line + "\n");
    } catch {
      /* ignore */
    }
  };
  return {
    debug: (m, ...r) => emit("debug", m, r),
    info: (m, ...r) => emit("info", m, r),
    warn: (m, ...r) => emit("warn", m, r),
    error: (m, ...r) => emit("error", m, r),
    child: (sub: string) => createLogger(`${scope}:${sub}`)
  };
}

export const log = createLogger("league-voice");
