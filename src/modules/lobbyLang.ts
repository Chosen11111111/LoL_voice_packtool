/** 大厅端: 客户端界面语言(LeagueClientSettings.yaml 里的 locale)。 */
import { isFile, readTextFile, readJsonFile, removeQuietly, writeFileAtomic } from "../core/fsx.ts";
import { classifyError } from "../core/errors.ts";
import { makeResult, type ModuleResult } from "../core/result.ts";
import { CLIENT_LOCALE_PATTERN, readClientLocale, settingsYamlPath } from "../core/paths.ts";
import type { SwitchEnv } from "./context.ts";

const MODULE = "lobby_lang" as const;

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
  const locale = readClientLocale(text) ?? "";
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
  const current = readClientLocale(text);
  if (!current) {
    return makeResult(MODULE, false, {
      action,
      planned: 1,
      success: 0,
      failed: 1,
      reason: "替换失败 1 个：配置文件里没有 locale 项",
      message: `配置文件里没有 locale 项: ${file}`
    });
  }
  const backup = `${file}.chosen_locale.json`;
  if (action === "restore") {
    if (!(await isFile(backup))) {
      return makeResult(MODULE, true, { action, planned: 0, success: 0, failed: 0, message: `未发现大厅语言修改记录，保留客户端当前语种 ${current}` });
    }
    const original = await readJsonFile<{ locale?: string }>(backup);
    locale = original?.locale ?? "";
  }
  if (!/^[a-z]{2}_[A-Z]{2}$/.test(locale)) {
    return makeResult(MODULE, false, { action, reason: "语种记录无效", message: `无法确定要${action === "restore" ? "还原" : "切换"}的大厅语种，未修改客户端配置。` });
  }
  const next = text.replace(CLIENT_LOCALE_PATTERN, (_match, prefix: string) => `${prefix}"${locale}"`);
  try {
    // 只记录首次修改前的语种，还原时保留客户端后来写入的其他设置。
    if (action === "apply" && !(await isFile(backup))) await writeFileAtomic(backup, JSON.stringify({ locale: current }) + "\n");
    await writeFileAtomic(file, next);
    if (action === "restore" && !(await removeQuietly(backup))) throw new Error("语种已还原，但原值记录未能清理");
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
    message: `大厅界面语言已${action === "restore" ? "恢复为原语种" : "切换为"} ${locale}`,
    detail: { path: file, locale }
  });
}

export async function applyLobbyLangEn(env: SwitchEnv): Promise<ModuleResult> {
  return writeLocale(env, "en_US", "apply");
}

export async function restoreLobbyLangZh(env: SwitchEnv): Promise<ModuleResult> {
  // 保留历史导出名；真正还原到首次修改前的语种，外服不能写死 zh_CN。
  return writeLocale(env, "zh_CN", "restore");
}

/** 任意语种的大厅界面语言(客户端原生支持, 未知语种会退回默认)。 */
export async function applyLobbyLang(locale: string, env: SwitchEnv): Promise<ModuleResult> {
  return writeLocale(env, locale, "apply");
}
