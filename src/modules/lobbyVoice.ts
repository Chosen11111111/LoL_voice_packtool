/**
 * 大厅端选人语音(后端能力, 默认不在界面暴露)。
 *
 * 实现链路: 语音插件(Chosen-VoiceSync) + 资源目录联接 + d3d9 加载桩 + 加载器配置。
 * 加载器固定使用"只含本语音插件"的精简目录, 不会把别的插件一起挂上去。
 *
 * 该能力由 features.lobbyVoice 开关控制(默认关闭): 关闭时界面与其他入口都不会走这里,
 * 但代码与接口保留, 需要时把开关打开即可。
 */
import path from "node:path";
import { isFile, pathExists, readJsonFile, removeQuietly, writeTextFile } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";
import { makeResult, type ModuleResult } from "../core/result.ts";
import { cdnLocale, localeDisplayName, lobbyAssetsDir } from "../packs/locales.ts";
import {
  ensureVoiceLoader,
  getStubStatus,
  placeStub,
  readLoaderIni,
  removeStub,
  writeLoaderIni
} from "../pengu/loader.ts";
import {
  DEFAULT_PLUGIN_CONFIG,
  ensurePluginInstalled,
  mountVoiceAssets,
  pluginTemplateDir,
  readPluginConfig,
  rewritePluginConfigBlock,
  unmountVoiceAssets,
  writePluginConfig,
  type PluginConfig
} from "../pengu/plugin.ts";
import type { SwitchEnv } from "./context.ts";

const MODULE = "lobby_voice" as const;
const logger = createLogger("lobby-voice");

async function activeLocaleFile(env: SwitchEnv): Promise<string> {
  return path.join(env.voiceRoot, "active_locale.json");
}

/** 确保插件就位(缺了就从内置模板装一份, 不依赖任何外部项目)。 */
async function ensurePlugin(env: SwitchEnv): Promise<{ ok: boolean; message: string }> {
  if (!env.penguDir || !env.pluginDir) {
    return {
      ok: false,
      message:
        "未找到加载器（需要 core.dll 与 d3d9_stub.dll）。\n" +
        "请把加载器目录放到本工具目录下，或在 config.json 里指定 penguLoaderDir。"
    };
  }
  const result = await ensurePluginInstalled(env.pluginDir, pluginTemplateDir(env.appDir));
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, message: result.message };
}

export interface LobbyVoiceOptions {
  progress?: import("../core/types.ts").ProgressReporter;
  signal?: AbortSignal;
}

/** 开启大厅选人原声语音。 */
export async function applyLobbyVoice(locale: string, env: SwitchEnv, options: LobbyVoiceOptions = {}): Promise<ModuleResult> {
  options.progress?.(0, 1);
  const plugin = await ensurePlugin(env);
  if (!plugin.ok) {
    return makeResult(MODULE, false, { planned: 0, success: 0, failed: 0, missing: true, reason: "资源缺失", message: plugin.message });
  }
  const pluginDir = env.pluginDir!;

  const assets = await lobbyAssetsDir(locale, env.voiceRoot);
  if (!assets) {
    return makeResult(MODULE, false, {
      planned: 0,
      success: 0,
      failed: 0,
      missing: true,
      reason: "资源缺失",
      message: `未找到 ${locale} 的大厅选人语音资源 assets/champion-choose-vo（当前资源目录：${env.voiceRoot}）`
    });
  }

  const cdn = cdnLocale(locale);

  // 1. 记录当前激活的语种
  try {
    await writeTextFile(await activeLocaleFile(env), JSON.stringify({ locale, cdn_locale: cdn }, null, 2) + "\n");
  } catch (error) {
    const reason = `写入激活配置失败：${String((error as Error).message ?? error)}`;
    return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: `替换失败 1 个：${reason}`, message: reason });
  }

  // 2. 挂载资源目录
  const [mounted, mountWhy] = await mountVoiceAssets(pluginDir, assets);
  if (!mounted) {
    return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: `替换失败 1 个：${mountWhy}`, message: mountWhy });
  }

  // 3. 插件配置(含 enabled 标志: 插件在内存中运行时也能立刻停手)
  const pluginConfig: PluginConfig = { enabled: true, locale, cdn_locale: cdn };
  const [configOk, configWhy] = await writePluginConfig(pluginDir, pluginConfig);
  if (!configOk) {
    const reason = `写入插件配置失败：${configWhy}`;
    return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: `替换失败 1 个：${reason}`, message: reason });
  }

  // 4. 同步插件脚本内的配置块(0 延迟生效)
  const [scriptOk, scriptWhy] = await rewritePluginConfigBlock(pluginDir, pluginConfig);
  if (!scriptOk) {
    const reason = `写入插件脚本失败：${scriptWhy}`;
    return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: `替换失败 1 个：${reason}`, message: reason });
  }

  // 5. 精简加载器: 只挂本语音插件
  const loader = await ensureVoiceLoader(env.penguDir!, pluginDir);
  if (!loader.ok) {
    return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: `替换失败 1 个：${loader.message}`, message: loader.message });
  }

  // 6. 加载桩 + 加载器配置
  const stub = await placeStub(env.penguDir!, env.resolution);
  if (!stub.ok) {
    return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: "替换失败 1 个：加载桩放置失败", message: stub.message });
  }
  const [iniOk, iniWhy] = await writeLoaderIni(true, loader.dir);
  if (!iniOk) {
    return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: `替换失败 1 个：${iniWhy}`, message: iniWhy });
  }

  options.progress?.(1, 1);
  logger.info(`大厅语音已开启: ${locale} loader=${loader.dir}`);
  return makeResult(MODULE, true, {
    planned: 1,
    success: 1,
    failed: 0,
    message: `大厅语音 1/1 已开启 ${localeDisplayName(locale)} 选人原声`,
    detail: { loader: loader.dir, assets, plugin: pluginDir }
  });
}

/** 还原大厅选人语音为官方默认(插件停用 + 卸载资源 + 移除加载桩)。 */
export async function restoreLobbyVoice(env: SwitchEnv, options: LobbyVoiceOptions = {}): Promise<ModuleResult> {
  options.progress?.(0, 1);
  const pluginDir = env.pluginDir;
  try {
    const active = await activeLocaleFile(env);
    if (await pathExists(active)) {
      const removed = await removeQuietly(active);
      if (!removed) {
        return makeResult(MODULE, false, {
          action: "restore",
          planned: 1,
          success: 0,
          failed: 1,
          reason: "还原失败 1 个：清理激活配置失败",
          message: `清理激活配置失败：${active}`
        });
      }
    }

    if (pluginDir) {
      const [ok, why] = await writePluginConfig(pluginDir, { ...DEFAULT_PLUGIN_CONFIG });
      if (!ok) {
        return makeResult(MODULE, false, {
          action: "restore",
          planned: 1,
          success: 0,
          failed: 1,
          reason: "还原失败 1 个：写入插件禁用配置失败",
          message: `写入插件禁用配置失败：${why}`
        });
      }
      const [scriptOk, scriptWhy] = await rewritePluginConfigBlock(pluginDir, { enabled: false, locale: "zh_CN", cdn_locale: "zh_cn" });
      if (!scriptOk) {
        return makeResult(MODULE, false, {
          action: "restore",
          planned: 1,
          success: 0,
          failed: 1,
          reason: "还原失败 1 个：写入插件脚本失败",
          message: `写入插件脚本失败：${scriptWhy}`
        });
      }
      await unmountVoiceAssets(pluginDir);
    }

    const ini = await readLoaderIni();
    if (ini.text) await writeLoaderIni(false, "");
    const stub = await removeStub(env.resolution);
    options.progress?.(1, 1);
    if (!stub.ok) {
      return makeResult(MODULE, false, {
        action: "restore",
        planned: 1,
        success: 0,
        failed: 1,
        reason: `还原失败 1 个：${stub.message}`,
        message: stub.message
      });
    }
    return makeResult(MODULE, true, { action: "restore", planned: 1, success: 1, failed: 0, message: "大厅语音已还原为官方默认" });
  } catch (error) {
    const message = String((error as Error).message ?? error);
    return makeResult(MODULE, false, {
      action: "restore",
      planned: 1,
      success: 0,
      failed: 1,
      reason: `还原失败 1 个：${message}`,
      message: `还原大厅语音失败: ${message}`
    });
  }
}

export interface LobbyStatus {
  ok: boolean;
  voice: string;
  lang: string;
  enabled: boolean;
  locale: string;
  stub_active: boolean;
  assets_mounted: boolean;
  loader_path: string;
  loader_dir: string | null;
  plugin_dir: string | null;
  plugin_installed: boolean;
  message: string;
}

/** 大厅端状态(加载桩 + 插件配置 + 资源挂载)。 */
export async function getLobbyStatus(env: SwitchEnv): Promise<LobbyStatus> {
  const stub = await getStubStatus(env.penguDir, env.resolution);
  const pluginDir = env.pluginDir;
  const assetsMounted = pluginDir ? await pathExists(path.join(pluginDir, "voice_assets")) : false;
  const config = pluginDir ? await readPluginConfig(pluginDir) : null;
  const active = await readJsonFile<{ locale?: string }>(await activeLocaleFile(env));
  const ini = await readLoaderIni();

  let enabled = false;
  if (stub.active) {
    if (assetsMounted || (await pathExists(await activeLocaleFile(env)))) enabled = true;
    else if (config) enabled = Boolean(config.enabled) && config.locale !== "zh_CN";
  }

  return {
    ok: true,
    voice: enabled ? "已开启" : "官方默认",
    lang: "未知",
    enabled,
    locale: config?.locale ?? active?.locale ?? "zh_CN",
    stub_active: stub.active,
    assets_mounted: assetsMounted,
    loader_path: ini.loaderPath,
    loader_dir: env.penguDir,
    plugin_dir: pluginDir,
    plugin_installed: pluginDir ? await isFile(path.join(pluginDir, "index.js")) : false,
    message: stub.message
  };
}
