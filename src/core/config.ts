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
  /** 二进制上传大小上限，0 表示不限制。 */
  maxUploadBytes: number;
}

export interface FeatureFlags {
  /** 大厅选人语音(需要加载器 + 客户端注入, 默认关闭, 仅保留后端能力)。 */
  lobbyVoice: boolean;
  /** 大厅界面语言(改 LeagueClientSettings.yaml, 与语音无关)。 */
  lobbyLang: boolean;
}

/** 窗口偏好随安装目录保存，不依赖浏览器缓存。null 表示旧配置尚未迁移。 */
export interface UiConfig {
  selectedLocale: string | null;
  modules: string[];
  volume: number | null;
  followClient: boolean | null;
  /** 播报固定延迟(毫秒): 官方台词略晚一点时, 用它对齐。缺省 1000。 */
  voiceDelayMs: number | null;

  /** 上次"开启语音包"的记录: 重启后界面能如实显示当前生效的是什么。 */
  lastApplied: { locale: string; modules: string[]; at: string } | null;
  /** 点过『不再提醒』后为 true: 以后再点开启语音包就不弹那段提示。 */
  hideEnableTip: boolean | null;
  /** 点过『收进托盘』并看过说明后为 true。 */
  hideTrayTip: boolean | null;
  /** 点"不再提醒"后为 true: 以后再点"开启语音包"就不弹那段提示了。 */
  region: "auto" | "cn" | "global";
}

export interface AppConfig {
  /** 语音包资源根目录(留空=自动探测)。 */
  voiceRoot: string;
  /** 联盟客户端目录(含 LeagueClient.exe, 留空=自动探测)。 */
  leaguePath: string;
  /** 游戏本体目录(含 League of Legends.exe, 留空=跟随客户端推导)。 */
  gamePath: string;
  /** CommunityDragon 资源根(仅用于识别 wad 条目指纹, 不影响语音包切换)。 */
  cdnBase: string;
  /** 默认语种。 */
  defaultLocale: string;
  /** 客户端基准语种(决定替换哪个槽位文件)。留空 = 自动探测。 */
  baseLocale: string;
  /** 需要维护的语种列表。 */
  supportedLocales: string[];
  /** 应用/还原后是否自动重启客户端 UX。 */
  autoRestartClient: boolean;
  /** 功能开关: 关掉的能力仍留在后端, 只是不在界面/默认流程里出现。 */
  features: FeatureFlags;
  server: ServerConfig;
  ui: UiConfig;
  logLevel: string;
}

export type ConfigPatch = Omit<Partial<AppConfig>, "ui"> & { ui?: Partial<UiConfig> };

const DEFAULT_CONFIG: AppConfig = {
  voiceRoot: "",
  leaguePath: "",
  gamePath: "",
  cdnBase: "https://raw.communitydragon.org/latest",
  defaultLocale: "ja_JP",
  baseLocale: "",
  supportedLocales: ["ja_JP", "ko_KR", "en_US"],
  autoRestartClient: true,
  features: { lobbyVoice: false, lobbyLang: true },
  server: { host: "127.0.0.1", port: 43110, token: "", webDir: "web", maxUploadBytes: 0 },
  ui: {
    selectedLocale: null,
    modules: ["ingame_voice", "ingame_lang", "lobby_voice"],
    volume: null,
    followClient: null,
    // 实测 1000ms 最贴合官方台词的节奏, 作为固定默认值
    voiceDelayMs: 1000,
    lastApplied: null,
  hideEnableTip: null,
  hideTrayTip: null,
    region: "auto"
  },
  logLevel: "info"
};

let cache: { file: string; config: AppConfig } | null = null;
let saveQueue: Promise<unknown> = Promise.resolve();

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

function mergeConfig(base: AppConfig, patch: ConfigPatch | null | undefined): AppConfig {
  if (!patch || typeof patch !== "object") return base;
  const merged: AppConfig = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    if (key === "server" && typeof value === "object") {
      merged.server = { ...base.server, ...(value as Partial<ServerConfig>) };
      continue;
    }
    if (key === "features" && typeof value === "object") {
      merged.features = { ...base.features, ...(value as Partial<FeatureFlags>) };
      continue;
    }
    if (key === "ui" && typeof value === "object") {
      merged.ui = { ...base.ui, ...(value as Partial<UiConfig>) };
      continue;
    }
    (merged as unknown as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/** 读取配置(带缓存)。文件不存在时返回默认值, 不落盘。 */
export async function loadConfig(force = false): Promise<AppConfig> {
  const file = configPath();
  if (cache?.file === file && !force) return structuredClone(cache.config);
  const stored = (await readJsonFile<Partial<AppConfig>>(file)) ?? {};
  const config = mergeConfig(defaultConfig(), stored);
  cache = { file, config };
  return structuredClone(config);
}

/** 合并并落盘(原子写)。 */
export function saveConfig(patch: ConfigPatch): Promise<AppConfig> {
  const file = configPath();
  const ownedPatch = structuredClone(patch);
  const saving = saveQueue.then(async () => {
    const stored = (await readJsonFile<Partial<AppConfig>>(file)) ?? {};
    const next = mergeConfig(mergeConfig(defaultConfig(), stored), ownedPatch);
    await ensureDir(path.dirname(file));
    await writeFileAtomic(file, JSON.stringify(next, null, 2) + "\n");
    cache = { file, config: next };
    return structuredClone(next);
  });
  saveQueue = saving.catch(() => undefined);
  return saving;
}

export async function resetConfig(): Promise<AppConfig> {
  cache = null;
  return saveConfig(defaultConfig());
}

export function invalidateConfigCache(): void {
  cache = null;
}
