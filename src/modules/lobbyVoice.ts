/**
 * 大厅端: 选人/禁用台词语音。
 *
 * 链路: 语音插件(Chosen-VoiceSync) + 资源目录联接 + d3d9 加载桩 + Rose 加载器配置。
 * 还原时必须写 config.json 的 enabled=false —— 插件已在内存里时, 只有这个标志能让它立刻停手。
 */
import path from "node:path";
import { isFile, pathExists, removeQuietly, writeTextFile } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";
import { makeResult, type ModuleResult } from "../core/result.ts";
import { readJsonFile } from "../core/fsx.ts";
import { cdnLocale, localeDisplayName } from "../packs/locales.ts";
import { lobbyAssetsDir } from "../packs/locales.ts";
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

/** 确保插件就位(缺了就从内置模板装一份, 独立工具不能依赖宿主项目)。 */
async function ensurePlugin(env: SwitchEnv): Promise<{ ok: boolean; message: string }> {
  if (!env.penguDir || !env.pluginDir) {
    return {
      ok: false,
      message:
        "未找到 Pengu Loader（需要 core.dll 与 d3d9_stub.dll）。\n" +
        "请把 Pengu Loader 放到项目目录下，或在 config.json 里指定 penguLoaderDir。"
    };
  }
  const result = await ensurePluginInstalled(env.pluginDir, pluginTemplateDir(env.appDir));
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, message: result.message };
}

export interface LobbyVoiceOptions {
  progress?: import("../core/types.ts").ProgressReporter;
  signal?: AbortSignal;
  /** 换肤插件同时开启时沿用完整加载器目录。 */
  skinsOn?: boolean;
}

/** 开启大厅选人原声语音。 */
export async function applyLobbyVoice(locale: string, env: SwitchEnv, options: LobbyVoiceOptions = {}): Promise<ModuleResult> {
  options.progress?.(0, 1);
  const plugin = await ensurePlugin(env);
  if (!plugin.ok) {
    return makeResult(MODULE, false, {
      planned: 0,
      success: 0,
      failed: 0,
      missing: true,
      reason: "资源缺失",
      message: plugin.message
    });
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

  // 3. 插件配置
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

  // 5. 加载器: 只开语音时用精简加载器, 换肤开启时沿用完整目录
  let loaderDir = env.penguDir!;
  if (!options.skinsOn) {
    const loader = await ensureVoiceLoader(env.penguDir!, pluginDir);
    if (!loader.ok) {
      return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: `替换失败 1 个：${loader.message}`, message: loader.message });
    }
    loaderDir = loader.dir;
  }

  const stub = await placeStub(env.penguDir!, env.resolution);
  if (!stub.ok) {
    return makeResult(MODULE, false, {
      planned: 1,
      success: 0,
      failed: 1,
      reason: `替换失败 1 个：加载桩放置失败`,
      message: stub.message
    });
  }

  const [iniOk, iniWhy] = await writeLoaderIni(true, loaderDir);
  if (!iniOk) {
    return makeResult(MODULE, false, { planned: 1, success: 0, failed: 1, reason: `替换失败 1 个：${iniWhy}`, message: iniWhy });
  }

  options.progress?.(1, 1);
  logger.info(`大厅语音已开启: ${locale} loader=${loaderDir}`);
  return makeResult(MODULE, true, {
    planned: 1,
    success: 1,
    failed: 0,
    message: `大厅语音 1/1 已开启 ${localeDisplayName(locale)} 选人原声`,
    detail: { loader: loaderDir, assets, plugin: pluginDir }
  });
}

/** 还原大厅选人语音为国服默认。 */
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

    // 插件在内存中运行时, 只有 config.json 的 enabled=false 能立刻停掉音频拦截
    if (pluginDir) {
      const [ok, why] = await writePluginConfig(pluginDir, { ...DEFAULT_PLUGIN_CONFIG });
      if (!ok) {
        return makeResult(MODULE, false, {
          action: "restore",
          planned: 1,
          success: 0,
          failed: 1,
          reason: `还原失败 1 个：写入插件禁用配置失败`,
          message: `写入插件禁用配置失败：${why}`
        });
      }
      const [scriptOk, scriptWhy] = await rewritePluginConfigBlock(pluginDir, {
        enabled: false,
        locale: "zh_CN",
        cdn_locale: "zh_cn"
      });
      if (!scriptOk) {
        return makeResult(MODULE, false, {
          action: "restore",
          planned: 1,
          success: 0,
          failed: 1,
          reason: `还原失败 1 个：写入插件脚本失败`,
          message: `写入插件脚本失败：${scriptWhy}`
        });
      }
      await unmountVoiceAssets(pluginDir);
    }

    if (options.skinsOn) {
      if (env.penguDir) await writeLoaderIni(true, env.penguDir);
      options.progress?.(1, 1);
      return makeResult(MODULE, true, {
        action: "restore",
        planned: 1,
        success: 1,
        failed: 0,
        message: "大厅语音已还原为官方默认（换肤保持开启）"
      });
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
    return makeResult(MODULE, true, {
      action: "restore",
      planned: 1,
      success: 1,
      failed: 0,
      message: "大厅语音已还原为官方默认"
    });
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
  pengu_dir: string | null;
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
    // 只有"资源挂载在"或"激活语种记录在"或"插件配置明确 enabled 且非 zh_CN"才算开启,
    // 避免与换肤预览共用 d3d9.dll 时误判
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
    pengu_dir: env.penguDir,
    plugin_dir: pluginDir,
    plugin_installed: pluginDir ? await isFile(path.join(pluginDir, "index.js")) : false,
    message: stub.message
  };
}
