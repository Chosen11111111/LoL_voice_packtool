/**
 * 以 ANSI(默认 GBK/936) 写文本文件。
 * Rose 的 config.ini 由 C++ 加载器按系统 ANSI 读取, 路径含中文时写 UTF-8 会乱码,
 * 而 Node 只能编码 UTF-8 —— 因此这里交给 PowerShell 的 Encoding 处理。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { runPowerShell } from "./shell.ts";

function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

export async function writeAnsiFile(file: string, text: string, codePage = 936): Promise<[boolean, string]> {
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => undefined);
  const script = `[IO.File]::WriteAllText(${psQuote(file)}, ${psQuote(text)}, [Text.Encoding]::GetEncoding(${codePage}))`;
  const result = await runPowerShell(script, { timeoutMs: 10000 });
  if (result.ok) return [true, ""];
  // PowerShell 不可用时退回 UTF-8(纯 ASCII 内容在两种编码下等价, 中文路径则可能乱码)
  try {
    await fs.writeFile(file, text, "utf8");
    return [true, ""];
  } catch (error) {
    return [false, String((error as Error).message ?? error)];
  }
}

/** 读 ANSI/UTF-8 文本(先按 UTF-8 试, 失败再交给 PowerShell 转码)。 */
export async function readTextAnyEncoding(file: string, codePage = 936): Promise<string | null> {
  try {
    const raw = await fs.readFile(file);
    const utf8 = raw.toString("utf8");
    if (!utf8.includes("\uFFFD")) return utf8;
  } catch {
    return null;
  }
  const script = `[IO.File]::ReadAllText(${psQuote(file)}, [Text.Encoding]::GetEncoding(${codePage}))`;
  const result = await runPowerShell(script, { timeoutMs: 10000 });
  if (result.ok) return result.stdout;
  return null;
}
