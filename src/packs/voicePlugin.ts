/**
 * 选人语音插件(voice-sync)的部署: 把插件放进加载器目录, 再把语音包的音频**联接**过去。
 *
 * 关键设计:
 *   1. 音频不复制 —— 用**目录联接(junction)**把 <语音包>/<语种>/assets 挂到插件目录,
 *      换语种只是换一个联接目标, 瞬间完成且不占额外空间;
 *   2. 开关写两处 —— config.json(运行时读) 与 index.js 里的配置块(注入时读)。加载器一旦
 *      注入就常驻内存, 只改一处会出现"关了还在拦"的情况;
 *   3. 插件就位即视为可用, **不需要客户端正在运行**。
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { isDirectory, isFile } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";
import { assetDir, loaderDir } from "../textpack/deploy.ts";

const logger = createLogger("voice-plugin");

/** 插件目录名(也是它在本地的虚拟源前缀 https://plugins/<名字>/)。 */
export const VOICE_PLUGIN_NAME = "voice-sync";

const CONFIG_START = "// __VOICE_CONFIG_START__";
const CONFIG_END = "// __VOICE_CONFIG_END__";

export interface VoicePluginConfig {
  enabled: boolean;
  locale: string;
  cdn_locale: string;
}

/** 语言代码 -> 社区数据源使用的目录名。 */
export const CDN_LOCALE_MAP: Record<string, string> = {
  zh_CN: "zh_cn",
  zh_TW: "zh_tw",
  en_US: "default",
  ja_JP: "ja_jp",
  ko_KR: "ko_kr",
  de_DE: "de_de",
  fr_FR: "fr_fr",
  es_ES: "es_es",
  es_MX: "es_mx",
  ru_RU: "ru_ru",
  pt_BR: "pt_br",
  tr_TR: "tr_tr",
  pl_PL: "pl_pl",
  it_IT: "it_it",
  vi_VN: "vi_vn",
  th_TH: "th_th"
};

export function cdnLocaleOf(locale: string): string {
  return CDN_LOCALE_MAP[locale] ?? "default";
}

export function voicePluginDir(): string {
  return path.join(loaderDir(), "plugins", VOICE_PLUGIN_NAME);
}

export function voiceAssetsLink(): string {
  return path.join(voicePluginDir(), "voice_assets");
}

export function voiceConfigFile(): string {
  return path.join(voicePluginDir(), "config.json");
}

/** 插件本体是否已就位(index.js 存在就算)。 */
export async function isVoicePluginStaged(): Promise<boolean> {
  return isFile(path.join(voicePluginDir(), "index.js"));
}

/** 建目录联接(不需要管理员权限); 已存在则先拆, 换语种就是"拆了重挂"。 */
export async function mountVoiceAssets(sourceDir: string): Promise<{ ok: boolean; message: string }> {
  if (!(await isDirectory(sourceDir))) return { ok: false, message: "语音资源目录不存在：" + sourceDir };
  const link = voiceAssetsLink();
  await unmountVoiceAssets();
  try {
    await fs.symlink(path.resolve(sourceDir), link, "junction");
  } catch (error) {
    return { ok: false, message: "挂载语音资源失败：" + String((error as Error).message).slice(0, 120) };
  }
  if (!(await isDirectory(link))) return { ok: false, message: "挂载语音资源失败(联接未生效)：" + link };
  logger.info("已挂载语音资源 " + sourceDir + " -> " + link);
  return { ok: true, message: "已挂载语音资源" };
}

/**
 * 拆联接。
 * 注意: 对 junction 必须用 cmd 的 rmdir —— fs.rm(recursive) 会删到目标目录里的音频,
 * 那是用户的语音包, 绝对不能碰。
 */
export async function unmountVoiceAssets(): Promise<void> {
  const link = voiceAssetsLink();
  if (!(await isDirectory(link))) return;
  await new Promise<void>((resolve) => {
    const child = spawn("cmd", ["/c", "rmdir", link], { windowsHide: true });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

/** 把 enabled/locale 同时写进 config.json 和 index.js 的配置块。 */
export async function writeVoiceConfig(config: VoicePluginConfig): Promise<{ ok: boolean; message: string }> {
  const dir = voicePluginDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(voiceConfigFile(), JSON.stringify(config, null, 2) + "\n", "utf8");
  } catch (error) {
    return { ok: false, message: "写入插件配置失败：" + String((error as Error).message).slice(0, 120) };
  }
  const indexFile = path.join(dir, "index.js");
  try {
    const text = await fs.readFile(indexFile, "utf8");
    const block = [
      CONFIG_START,
      "  var enabled = " + (config.enabled ? "true" : "false") + ";",
      "  var locale = " + JSON.stringify(config.locale) + ";",
      "  var cdnLocale = " + JSON.stringify(config.cdn_locale) + ";",
      CONFIG_END
    ].join("\n");
    const start = text.indexOf(CONFIG_START);
    const end = text.indexOf(CONFIG_END);
    if (start < 0 || end < 0) return { ok: false, message: "插件脚本里没有配置标记块，无法写入" };
    const next = text.slice(0, start) + block + text.slice(end + CONFIG_END.length);
    await fs.writeFile(indexFile, next, "utf8");
  } catch (error) {
    return { ok: false, message: "写入插件脚本失败：" + String((error as Error).message).slice(0, 120) };
  }
  return { ok: true, message: "已写入插件配置" };
}

export async function readVoiceConfig(): Promise<VoicePluginConfig | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(voiceConfigFile(), "utf8")) as Partial<VoicePluginConfig>;
    return {
      enabled: parsed.enabled === true,
      locale: typeof parsed.locale === "string" ? parsed.locale : "zh_CN",
      cdn_locale: typeof parsed.cdn_locale === "string" ? parsed.cdn_locale : "zh_cn"
    };
  } catch {
    return null;
  }
}

/** 把软件包里的插件拷进加载器目录。 */
export async function stageVoicePlugin(): Promise<{ ok: boolean; message: string }> {
  const source = path.join(assetDir(), "voice-sync", "index.js");
  if (!(await isFile(source))) return { ok: false, message: "软件包里缺少 voice-sync 插件" };
  const dir = voicePluginDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "index.js"), await fs.readFile(source));
  } catch (error) {
    return { ok: false, message: "复制插件失败：" + String((error as Error).message).slice(0, 120) };
  }
  return { ok: true, message: "插件已就位" };
}

/** 统计某语种语音包里的台词条数。 */
export async function countVoiceLines(assetsRoot: string): Promise<number> {
  let total = 0;
  for (const kind of ["champion-choose-vo", "champion-ban-vo"]) {
    try {
      const names = await fs.readdir(path.join(assetsRoot, kind));
      total += names.filter((n) => n.toLowerCase().endsWith(".ogg")).length;
    } catch {
      // 目录不存在就跳过
    }
  }
  return total;
}
