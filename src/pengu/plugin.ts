/** Chosen-VoiceSync 插件的安装、配置与资源挂载。 */
import path from "node:path";
import { clearMountPoint, copyFilePreserve, createJunction, ensureDir, isDirectory, isFile, listNames, pathExists, readJsonFile, readTextFile, removeJunction, writeTextFile } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";
import { CDN_LOCALE_MAP } from "../packs/locales.ts";
import { VOICE_PLUGIN_NAME } from "../version.ts";

const logger = createLogger("pengu-plugin");

export interface PluginConfig {
  enabled: boolean;
  locale: string;
  cdn_locale: string;
}

export const DEFAULT_PLUGIN_CONFIG: PluginConfig = { enabled: false, locale: "zh_CN", cdn_locale: "zh_cn" };

export const CONFIG_BLOCK_START = "// __CHOSEN_VOICE_CONFIG_START__";
export const CONFIG_BLOCK_END = "// __CHOSEN_VOICE_CONFIG_END__";

export function pluginTemplateDir(appDir: string): string {
  return path.join(appDir, "assets", "pengu-plugin", VOICE_PLUGIN_NAME);
}

export function voicePluginDir(loaderDir: string): string {
  return path.join(loaderDir, "plugins", VOICE_PLUGIN_NAME);
}

/** 插件是否已就位(index.js 存在)。 */
export async function isPluginInstalled(pluginDir: string): Promise<boolean> {
  return isFile(path.join(pluginDir, "index.js"));
}

/** 从内置模板安装插件(不覆盖已存在的自定义版本, 除非 force)。 */
export async function ensurePluginInstalled(
  pluginDir: string,
  templateDir: string,
  options: { force?: boolean } = {}
): Promise<{ ok: boolean; installed: boolean; message: string }> {
  const indexFile = path.join(pluginDir, "index.js");
  if (!options.force && (await isFile(indexFile))) return { ok: true, installed: false, message: "插件已存在" };
  if (!(await isDirectory(templateDir))) {
    return { ok: false, installed: false, message: `未找到内置插件模板：${templateDir}` };
  }
  await ensureDir(pluginDir);
  let copied = 0;
  for (const name of await listNames(templateDir)) {
    const src = path.join(templateDir, name);
    if (!(await isFile(src))) continue;
    try {
      await copyFilePreserve(src, path.join(pluginDir, name));
      copied += 1;
    } catch (error) {
      return { ok: false, installed: false, message: `安装插件文件失败 ${name}：${String((error as Error).message ?? error)}` };
    }
  }
  if (!(await isFile(indexFile))) return { ok: false, installed: false, message: "插件模板里缺少 index.js" };
  logger.info(`已安装语音插件到 ${pluginDir}（${copied} 个文件）`);
  return { ok: true, installed: true, message: `已安装语音插件（${copied} 个文件）` };
}

export async function readPluginConfig(pluginDir: string): Promise<PluginConfig | null> {
  return readJsonFile<PluginConfig>(path.join(pluginDir, "config.json"));
}

/** 写插件本地配置(含 enabled 标志; 插件运行时会读取它, 无需重启即可停用)。 */
export async function writePluginConfig(pluginDir: string, config: PluginConfig): Promise<[boolean, string]> {
  try {
    await ensureDir(pluginDir);
    await writeTextFile(path.join(pluginDir, "config.json"), JSON.stringify(config, null, 2) + "\n");
    return [true, ""];
  } catch (error) {
    return [false, String((error as Error).message ?? error)];
  }
}

/** 重写 index.js 里的代码配置块, 让插件即使读不到 config.json 也立刻生效。 */
export async function rewritePluginConfigBlock(
  pluginDir: string,
  config: Pick<PluginConfig, "enabled" | "locale" | "cdn_locale">
): Promise<[boolean, string]> {
  const indexFile = path.join(pluginDir, "index.js");
  const text = await readTextFile(indexFile);
  if (text === null) return [true, ""]; // 没有 index.js 不算失败, 由调用方决定
  const cdnLocale = config.cdn_locale || CDN_LOCALE_MAP[config.locale] || "default";
  const block = [
    CONFIG_BLOCK_START,
    `  let enabled = ${config.enabled};`,
    `  let targetLocale = "${config.locale}";`,
    `  let targetCdnLocale = "${cdnLocale}";`,
    `  ${CONFIG_BLOCK_END}`
  ].join("\n");

  let next: string;
  if (text.includes(CONFIG_BLOCK_START)) {
    const pattern = new RegExp(`${escapeRegExp(CONFIG_BLOCK_START)}[\\s\\S]*?${escapeRegExp(CONFIG_BLOCK_END)}`);
    next = text.replace(pattern, block);
  } else {
    next = text.replace(/let targetLocale\s*=\s*["'][^"']+["'];?/, block);
  }
  if (next === text && !text.includes(CONFIG_BLOCK_START)) {
    return [false, "插件脚本里没有可写入的配置块"];
  }
  try {
    await writeTextFile(indexFile, next);
    return [true, ""];
  } catch (error) {
    return [false, String((error as Error).message ?? error)];
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把选中语种的 assets 目录挂到插件目录(目录联接, 本地直读)。 */
export async function mountVoiceAssets(pluginDir: string, sourceAssets: string): Promise<[boolean, string]> {
  const link = path.join(pluginDir, "voice_assets");
  if (await pathExists(link)) {
    const removed = await clearMountPoint(link);
    if (!removed) {
      return [false, `挂载语音资源失败(${link} 已被占用且不是目录联接, 请手动处理后重试)`];
    }
  }
  const [created, why] = await createJunction(link, sourceAssets);
  if (!created) return [false, `挂载语音资源失败(${why})`];
  const probe = path.join(link, "champion-choose-vo");
  if (await isDirectory(probe)) {
    const files = await listNames(probe);
    if (files.some((name) => name.toLowerCase().endsWith(".ogg"))) return [true, ""];
    return [false, `挂载语音资源失败(目录联接已建立但读不到选人语音: ${probe})`];
  }
  return [false, `挂载语音资源失败(目录联接未生效: ${link})`];
}

export async function unmountVoiceAssets(pluginDir: string): Promise<boolean> {
  const link = path.join(pluginDir, "voice_assets");
  if (!(await pathExists(link))) return true;
  return removeJunction(link);
}
