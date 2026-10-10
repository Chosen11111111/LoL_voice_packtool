/** 一次操作共享的运行环境: 路径只解析一次, 所有模块复用同一结果。 */
import path from "node:path";
import { appRoot, type AppConfig } from "../core/config.ts";
import { resolveGamePaths, resolveVoiceRoot, type GamePathResolution } from "../core/paths.ts";
import { detectPenguLoaderDir } from "../pengu/loader.ts";
import { voicePluginDir } from "../pengu/plugin.ts";
import { createLogger } from "../core/logger.ts";

const logger = createLogger("context");

export interface SwitchEnv {
  config: AppConfig;
  appDir: string;
  voiceRoot: string;
  voiceRootSource: string;
  penguDir: string | null;
  pluginDir: string | null;
  resolution: GamePathResolution;
  finalDir: string | null;
  leagueDir: string | null;
}

export interface BuildEnvOptions {
  config: AppConfig;
  appDir?: string;
  skipProcess?: boolean;
  skipAutoDetect?: boolean;
  /** 强制指定资源根(测试/多实例用)。 */
  voiceRoot?: string;
}

export async function buildEnv(options: BuildEnvOptions): Promise<SwitchEnv> {
  const appDir = options.appDir ?? appRoot();
  const config = options.config;

  const voiceRootResolution = options.voiceRoot
    ? { root: path.resolve(options.voiceRoot), source: "config" as const, candidates: [], hasPacks: true }
    : await resolveVoiceRoot(config, appDir);

  const resolution = await resolveGamePaths({
    leaguePath: config.leaguePath,
    gamePath: config.gamePath,
    skipProcess: options.skipProcess,
    skipAutoDetect: options.skipAutoDetect
  });

  const penguDir = await detectPenguLoaderDir({ configured: config.penguLoaderDir, appDir });
  const pluginDir = penguDir ? voicePluginDir(penguDir) : null;
  if (!voiceRootResolution.hasPacks) {
    logger.warn(`资源根目录下未发现任何语种包: ${voiceRootResolution.root}`);
  }
  return {
    config,
    appDir,
    voiceRoot: voiceRootResolution.root,
    voiceRootSource: voiceRootResolution.source,
    penguDir,
    pluginDir,
    resolution,
    finalDir: resolution.finalDir,
    leagueDir: resolution.leagueDir || null
  };
}

/** 模块执行上下文(带进度与取消)。 */
export interface ModuleRunOptions {
  progress?: import("../core/types.ts").ProgressReporter;
  signal?: AbortSignal;
}
