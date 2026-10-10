/**
 * 配置存储(单个 JSON, 原子写入)。
 * 独立工具不依赖宿主项目的 Config, 自己一份 config.json 说了算。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFile, writeFileAtomic, ensureDir } from "./fsx.ts";

export interface ServerConfig {
  host: string;
  port: number;
  /** 非回环监听时需要的访问令牌(空=不校验)。 */
  token: string;
  /** 前端静态目录(相对项目根或绝对路径)。换成自己的 UI 时指到这里即可。 */
  webDir: string;
}

export interface DownloadConfig {
  /** 局内 wad 下载线程数(传给 ManifestDownloader)。 */
  threads: number;
  /** 大厅资源并发数。 */
  concurrency: number;
  timeoutMs: number;
  retries: number;
}

export interface FeatureFlags {
  /** 大厅选人语音(需要加载器 + 客户端注入, 默认关闭, 仅保留后端能力)。 */
  lobbyVoice: boolean;
  /** 大厅界面语言(改 LeagueClientSettings.yaml, 与语音无关)。 */
  lobbyLang: boolean;
}

export interface AppConfig {
  /** 语音包资源根目录(留空=自动探测)。 */
  voiceRoot: string;
  /** 联盟客户端目录(含 LeagueClient.exe, 留空=自动探测)。 */
  leaguePath: string;
  /** 游戏本体目录(含 League of Legends.exe, 留空=跟随客户端推导)。 */
  gamePath: string;
  /** Pengu Loader 目录(含 core.dll, 留空=自动探测)。 */
  penguLoaderDir: string;
  /** 清单下载器可执行文件(相对项目根或绝对路径)。 */
  manifestDownloader: string;
  /** 清单 ID。 */
  manifestId: string;
  /** wad 切片加速代理。 */
  bundleProxy: string;
  /** CommunityDragon 资源根。 */
  cdnBase: string;
  /** 默认语种。 */
  defaultLocale: string;
  /** 需要维护的语种列表。 */
  supportedLocales: string[];
  /** 应用/还原后是否自动重启客户端 UX。 */
  autoRestartClient: boolean;
  /** 功能开关: 关掉的能力仍留在后端, 只是不在界面/默认流程里出现。 */
  features: FeatureFlags;
  server: ServerConfig;
  download: DownloadConfig;
  logLevel: string;
}

const DEFAULT_CONFIG: AppConfig = {
  voiceRoot: "",
  leaguePath: "",
  gamePath: "",
  penguLoaderDir: "",
  manifestDownloader: "ManifestDownloader.exe",
  manifestId: "37D5BB71755990B9",
  bundleProxy: "https://gh.chosen.cc.cd/channels/public/bundles",
  cdnBase: "https://raw.communitydragon.org/latest",
  defaultLocale: "ja_JP",
  supportedLocales: ["ja_JP", "ko_KR", "en_US"],
  autoRestartClient: true,
  features: { lobbyVoice: false, lobbyLang: true },
  server: { host: "127.0.0.1", port: 43110, token: "", webDir: "web" },
  download: { threads: 16, concurrency: 16, timeoutMs: 30000, retries: 3 },
  logLevel: "info"
};

let cache: AppConfig | null = null;

/** 项目根目录(可用 LEAGUE_VOICE_HOME 覆盖, 打包后可指向安装目录)。 */
export function appRoot(): string {
  const override = process.env.LEAGUE_VOICE_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  const here = path.dirname(fileURLToPath(import.meta.url)); // <root>/src/core
  return path.resolve(here, "..", "..");
}

export function configPath(): string {
  const override = process.env.LEAGUE_VOICE_CONFIG;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(appRoot(), "config.json");
}

export function defaultConfig(): AppConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function mergeConfig(base: AppConfig, patch: Partial<AppConfig> | null | undefined): AppConfig {
  if (!patch || typeof patch !== "object") return base;
  const merged: AppConfig = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    if (key === "server" && typeof value === "object") {
      merged.server = { ...base.server, ...(value as Partial<ServerConfig>) };
      continue;
    }
    if (key === "download" && typeof value === "object") {
      merged.download = { ...base.download, ...(value as Partial<DownloadConfig>) };
      continue;
    }
    if (key === "features" && typeof value === "object") {
      merged.features = { ...base.features, ...(value as Partial<FeatureFlags>) };
      continue;
    }
    (merged as unknown as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/** 读取配置(带缓存)。文件不存在时返回默认值, 不落盘。 */
export async function loadConfig(force = false): Promise<AppConfig> {
  if (cache && !force) return cache;
  const stored = (await readJsonFile<Partial<AppConfig>>(configPath())) ?? {};
  cache = mergeConfig(defaultConfig(), stored);
  return cache;
}

/** 合并并落盘(原子写)。 */
export async function saveConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const current = await loadConfig(true);
  const next = mergeConfig(current, patch);
  await ensureDir(path.dirname(configPath()));
  await writeFileAtomic(configPath(), JSON.stringify(next, null, 2) + "\n");
  cache = next;
  return next;
}

export async function resetConfig(): Promise<AppConfig> {
  cache = null;
  return saveConfig(defaultConfig());
}

export function invalidateConfigCache(): void {
  cache = null;
}
