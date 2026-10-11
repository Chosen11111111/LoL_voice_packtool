/**
 * 子进程薄封装。
 *
 * 为什么不用 simple exec: 受限环境(沙箱/杀软)下"管道捕获子进程输出"可能直接 EPERM。
 * 这里先用管道, 失败后自动退回"把输出写进临时文件再读回", 保证探测类调用不因环境而失效。
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errorText } from "../errors.ts";

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error: string;
  /** 输出是否因为读取失败而缺失(调用方据此决定是否降级判断)。 */
  outputUnavailable: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  /** 子进程环境变量(默认继承)。 */
  env?: NodeJS.ProcessEnv;
}

function decode(buffer: Buffer): string {
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

/** 把输出重定向到临时文件执行(绕过命名管道限制)。 */
async function runViaFiles(exe: string, args: string[], options: RunOptions): Promise<RunResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "league-voice-run-"));
  const outFile = path.join(dir, "out.txt");
  const errFile = path.join(dir, "err.txt");
  const outHandle = await fs.open(outFile, "w");
  const errHandle = await fs.open(errFile, "w");
  try {
    const result = await new Promise<{ code: number | null; error: string }>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const child = spawn(exe, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        stdio: ["ignore", outHandle.fd, errHandle.fd]
      });
      const finish = (code: number | null, error: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ code, error });
      };
      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
          finish(null, "timeout");
        }, options.timeoutMs);
      }
      child.on("error", (error) => finish(null, errorText(error)));
      child.on("close", (code) => finish(code, ""));
    });
    const [stdout, stderr] = await Promise.all([
      fs.readFile(outFile, "utf8").catch(() => ""),
      fs.readFile(errFile, "utf8").catch(() => "")
    ]);
    return {
      ok: result.error === "" && result.code === 0,
      code: result.code,
      stdout: decode(Buffer.from(stdout)),
      stderr: decode(Buffer.from(stderr)),
      error: result.error,
      outputUnavailable: false
    };
  } finally {
    await outHandle.close().catch(() => undefined);
    await errHandle.close().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 执行外部程序并收集输出(管道优先, 受限环境自动退回临时文件)。 */
export async function run(exe: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 15000;
  const piped = await new Promise<RunResult>((resolve) => {
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, code: null, stdout: "", stderr: "", error: errorText(error), outputUnavailable: true });
      return;
    }
    const finish = (payload: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };
    child.stdout?.on("data", (chunk: Buffer) => outChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => errChunks.push(chunk));
    child.on("error", (error) => {
      const message = errorText(error);
      const sandboxed = /EPERM|EACCES|EPIPE|ENOTSUP|UNKNOWN/i.test(message);
      finish({
        ok: false,
        code: null,
        stdout: "",
        stderr: "",
        error: message,
        outputUnavailable: sandboxed
      });
    });
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({
        ok: false,
        code: null,
        stdout: decode(Buffer.concat(outChunks)),
        stderr: decode(Buffer.concat(errChunks)),
        error: "timeout",
        outputUnavailable: false
      });
    }, timeoutMs);
    child.on("close", (code) => {
      finish({
        ok: code === 0,
        code,
        stdout: decode(Buffer.concat(outChunks)),
        stderr: decode(Buffer.concat(errChunks)),
        error: "",
        outputUnavailable: false
      });
    });
  });

  if (piped.ok || !piped.outputUnavailable) return piped;
  // 管道被环境拒绝: 退回文件重定向
  try {
    return await runViaFiles(exe, args, { ...options, timeoutMs });
  } catch (error) {
    return {
      ok: false,
      code: null,
      stdout: "",
      stderr: "",
      error: errorText(error),
      outputUnavailable: true
    };
  }
}

const PS_EXE = process.env.LEAGUE_VOICE_POWERSHELL || "powershell.exe";

/** PowerShell 脚本以 Base64(UTF-16LE) 传入, 彻底绕开引号与中文转义问题。 */
export function encodePowerShell(script: string): string {
  const prefix = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';$ErrorActionPreference='SilentlyContinue';";
  return Buffer.from(prefix + script, "utf16le").toString("base64");
}

export async function runPowerShell(script: string, options: RunOptions = {}): Promise<RunResult> {
  return run(PS_EXE, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)], {
    timeoutMs: options.timeoutMs ?? 20000,
    cwd: options.cwd
  });
}

/** 长任务: 流式读取输出(下载器/安装器)。管道受限时退化为"只看退出码"。 */
export async function runStreaming(
  exe: string,
  args: string[],
  options: RunOptions & { onLine?: (line: string) => void; signal?: AbortSignal; maxBuffer?: number } = {}
): Promise<RunResult> {
  if (options.signal?.aborted) return { ok: false, code: null, stdout: "", stderr: "", error: "aborted", outputUnavailable: false };
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 0;
  const maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024;
  return new Promise<RunResult>((resolve) => {
    const chunks: string[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let pending = "";
    let stopReason = "";
    let child: ReturnType<typeof spawn>;
    const finish = (payload: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(payload);
    };
    const onAbort = () => {
      if (settled || stopReason) return;
      stopReason = "aborted";
      try {
        child?.kill();
      } catch {
        /* ignore */
      }
    };
    const consume = (text: string) => {
      if (size < maxBuffer) {
        chunks.push(text);
        size += text.length;
      }
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) options.onLine?.(line.trim());
      }
    };
    try {
      child = spawn(exe, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ ok: false, code: null, stdout: "", stderr: "", error: errorText(error), outputUnavailable: true });
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => consume(decode(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => consume(decode(chunk)));
    child.on("error", (error) => {
      const message = errorText(error);
      finish({
        ok: false,
        code: null,
        stdout: chunks.join(""),
        stderr: "",
        error: stopReason || message,
        outputUnavailable: /EPERM|EACCES|EPIPE|ENOTSUP|UNKNOWN/i.test(message)
      });
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        stopReason = "timeout";
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }, timeoutMs);
    }
    child.on("close", (code) => {
      if (pending.trim()) options.onLine?.(pending.trim());
      finish({ ok: !stopReason && code === 0, code, stdout: chunks.join(""), stderr: "", error: stopReason, outputUnavailable: false });
    });
    if (options.signal?.aborted) onAbort();
  });
}
