/** 注册表读取(经 reg.exe, 零依赖)。 */
import { run } from "./shell.ts";
import { log } from "../logger.ts";

const logger = log.child("registry");

export interface RegValue {
  name: string;
  type: string;
  value: string;
}

function parseValues(text: string): RegValue[] {
  const values: RegValue[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const match = /^\s{2,}(\S.*?)\s{4,}(REG_[A-Z_]+)\s{4,}(.*)$/.exec(line);
    if (match) {
      values.push({ name: match[1]!.trim(), type: match[2]!, value: match[3]!.trim() });
      continue;
    }
    // 默认值(REG_SZ 但名称为空)在 reg query 里显示为 "(默认)"
    const defMatch = /^\s{2,}\(默认\)\s{4,}(REG_[A-Z_]+)\s{4,}(.*)$/.exec(line);
    if (defMatch) values.push({ name: "", type: defMatch[1]!, value: defMatch[2]!.trim() });
  }
  return values;
}

/** 读取某个键下的全部值; 键不存在返回空数组。 */
export async function regQueryValues(key: string): Promise<RegValue[]> {
  const result = await run("reg", ["query", key], { timeoutMs: 8000 });
  if (!result.ok || !result.stdout) {
    logger.debug(`reg query ${key} -> code=${result.code} err=${result.error}`);
    return [];
  }
  return parseValues(result.stdout);
}

/** 读取单个值(找不到返回 null)。 */
export async function regQueryValue(key: string, valueName: string, view?: "32" | "64"): Promise<string | null> {
  const args = ["query", key, "/v", valueName];
  if (view) args.push(`/${view}`);
  const result = await run("reg", args, { timeoutMs: 8000 });
  if (!result.ok || !result.stdout) return null;
  const values = parseValues(result.stdout);
  const hit = values.find((item) => item.name.toLowerCase() === valueName.toLowerCase());
  return hit ? hit.value : null;
}

/** 键是否存在。 */
export async function regKeyExists(key: string): Promise<boolean> {
  const result = await run("reg", ["query", key], { timeoutMs: 8000 });
  return result.ok;
}
