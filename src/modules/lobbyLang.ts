/** 大厅端: 客户端界面语言(LeagueClientSettings.yaml 里的 locale)。 */
import { isFile, readTextFile, writeTextFile } from "../core/fsx.ts";
import { classifyError } from "../core/errors.ts";
import { makeResult, type ModuleResult } from "../core/result.ts";
import { settingsYamlPath } from "../core/paths.ts";
import type { SwitchEnv } from "./context.ts";

const MODULE = "lobby_lang" as const;
const LOCALE_PATTERN = /locale:\s*["']([^"']+)["']/;

export interface LobbyLangState {
  available: boolean;
  path: string | null;
  locale: string;
  label: string;
}

/** 当前大厅界面语言。 */
export async function getLobbyLangState(env: SwitchEnv): Promise<LobbyLangState> {
  const file = await settingsYamlPath(env.resolution);
  if (!file || !(await isFile(file))) {
    return { available: false, path: file, locale: "", label: "未找到客户端配置文件" };
  }
  const text = (await readTextFile(file)) ?? "";
  const match = LOCALE_PATTERN.exec(text);
  const locale = match?.[1] ?? "";
  const label = locale === "en_US" ? "全英文 (en_US)" : locale === "zh_CN" ? "默认中文 (zh_CN)" : locale || "未知";
  return { available: true, path: file, locale, label };
}

async function writeLocale(env: SwitchEnv, locale: string, action: "apply" | "restore"): Promise<ModuleResult> {
  const file = await settingsYamlPath(env.resolution);
  if (!file) {
    return makeResult(MODULE, false, { action, reason: "游戏路径未就绪", message: env.resolution.message });
  }
  if (!(await isFile(file))) {
    return makeResult(MODULE, false, { action, reason: "资源缺失", missing: true, message: `未找到客户端配置文件: ${file}` });
  }
  const text = await readTextFile(file);
  if (text === null) {
    return makeResult(MODULE, false, { action, reason: "替换失败 1 个：配置文件不可读", message: `无法读取配置文件: ${file}` });
  }
  if (!LOCALE_PATTERN.test(text)) {
    return makeResult(MODULE, false, {
      action,
      planned: 1,
      success: 0,
      failed: 1,
      reason: "替换失败 1 个：配置文件里没有 locale 项",
      message: `配置文件里没有 locale 项: ${file}`
    });
  }
  const next = text.replace(LOCALE_PATTERN, `locale: "${locale}"`);
  try {
    await writeTextFile(file, next);
  } catch (error) {
    const reason = classifyError(error);
    return makeResult(MODULE, false, {
      action,
      planned: 1,
      success: 0,
      failed: 1,
      reason: `${action === "apply" ? "替换" : "还原"}失败 1 个：${reason}`,
      message: `写入客户端配置失败：${reason}`
    });
  }
  return makeResult(MODULE, true, {
    action,
    planned: 1,
    success: 1,
    failed: 0,
    message: locale === "en_US" ? "大厅界面语言已切换为全英文 (en_US)" : "大厅界面语言已恢复为默认中文 (zh_CN)",
    detail: { path: file, locale }
  });
}

export async function applyLobbyLangEn(env: SwitchEnv): Promise<ModuleResult> {
  return writeLocale(env, "en_US", "apply");
}

export async function restoreLobbyLangZh(env: SwitchEnv): Promise<ModuleResult> {
  return writeLocale(env, "zh_CN", "restore");
}

/** 任意语种的大厅界面语言(客户端原生支持, 未知语种会退回默认)。 */
export async function applyLobbyLang(locale: string, env: SwitchEnv): Promise<ModuleResult> {
  return writeLocale(env, locale, "apply");
}
