/**
 * 客户端自带资源包(WAD)的定位与解析。
 *
 * 已实测确认的格式(RW 3.4, 以 LeagueClient\\Plugins\\rcp-be-lol-game-data\\zh_CN-assets.wad 为例):
 *   0..3      magic "RW" + 版本(3.4)
 *   4..259    256 字节签名块
 *   260..267  8 字节校验/摘要
 *   268..271  条目数(u32)
 *   272..     TOC: 每条 32 字节, [+8]=数据偏移(u32) [+12]/[+16]=大小(u32) [+24]=路径哈希(u64)
 *   TOC 之后 数据区(条目按偏移指向)
 */
import path from "node:path";
import { isFile, isDirectory, listNames } from "../core/fsx.ts";
import { createLogger } from "../core/logger.ts";

const logger = createLogger("wadfile");

export const GAME_DATA_PLUGIN = "rcp-be-lol-game-data";
export const WAD_HEADER_SIZE = 268;
export const WAD_ENTRY_SIZE = 32;

export interface WadLocation {
  ok: boolean;
  path: string | null;
  pluginDir: string | null;
  message: string;
}

/** 插件目录可能有两种布局: <root>/LeagueClient/Plugins/... 与 <root>/Plugins/...。 */
function pluginDirCandidates(clientDir: string): string[] {
  return [
    path.join(clientDir, "Plugins", GAME_DATA_PLUGIN),
    path.join(clientDir, "LeagueClient", "Plugins", GAME_DATA_PLUGIN)
  ];
}

/**
 * 定位客户端当前语种对应的资源包。
 * 客户端按 description.json 里的 perLocaleAssetBundles 加载 <locale>-assets.wad。
 */
export async function locateClientAssetWad(clientDir: string | null, locale: string): Promise<WadLocation> {
  if (!clientDir) {
    return { ok: false, path: null, pluginDir: null, message: "未定位到联盟客户端目录" };
  }
  for (const pluginDir of pluginDirCandidates(clientDir)) {
    if (!(await isDirectory(pluginDir))) continue;
    const exact = path.join(pluginDir, `${locale}-assets.wad`);
    if (await isFile(exact)) return { ok: true, path: exact, pluginDir, message: "已定位资源包" };
    const names = await listNames(pluginDir);
    const fallback = names.find((name) => /^[a-z]{2}_[A-Z]{2}-assets\.wad$/.test(name));
    if (fallback) {
      const located = path.join(pluginDir, fallback);
      logger.debug(`未找到 ${locale}-assets.wad, 退回 ${fallback}`);
      return { ok: true, path: located, pluginDir, message: `未找到 ${locale}-assets.wad，回退到 ${fallback}` };
    }
    return {
      ok: false,
      path: null,
      pluginDir,
      message: `插件目录里没有语种资源包（期望 ${locale}-assets.wad）：${pluginDir}`
    };
  }
  return {
    ok: false,
    path: null,
    pluginDir: null,
    message: `未找到客户端资源插件目录：${pluginDirectoriesHint(clientDir)}`
  };
}

function pluginDirectoriesHint(clientDir: string): string {
  return pluginDirCandidates(clientDir).join(" 或 ");
}
