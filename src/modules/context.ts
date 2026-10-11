/** 一次操作共享的运行环境: 路径只解析一次, 所有模块复用同一结果。 */
import path from "node:path";
import { appRoot, type AppConfig } from "../core/config.ts";
import { resolveGamePaths, resolveVoiceRoot, type GamePathResolution } from "../core/paths.ts";
import { detectBaseLocale, detectRegion, type ClientRegion } from "../packs/baselocale.ts";
import { regionProfile, resolveRegion, type RegionProfile, type RegionSource } from "../packs/region.ts";
import { setClientDirHint } from "../core/win/processes.ts";
import { createLogger } from "../core/logger.ts";

const logger = createLogger("context");

export interface SwitchEnv {
  config: AppConfig;
  appDir: string;
  voiceRoot: string;
  voiceRootSource: string;
  resolution: GamePathResolution;
  finalDir: string | null;
  leagueDir: string | null;
  /** 客户端当前语种: 决定要替换哪个槽位文件(国服 zh_CN, 国际服按实际)。 */
  baseLocale: string;
  baseLocaleSource: string;
  baseLocaleDetail: string;
  /** 客户端渠道: 由右上角按钮决定(按钮为"自动"时才用路径探测)。 */
  region: ClientRegion;
  /** 渠道是怎么定下来的: ui=按钮, detected=按客户端路径探测。 */
  regionSource: RegionSource;
  /** 该渠道的差异档案(自带语种/下载地址等)。 */
  regionProfile: RegionProfile;
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

  const detectedRegion = detectRegion(resolution.leagueDir || null, resolution.sourceDetail);
  // 右上角按钮优先: 选了国服就走国服那套, 选了外服就走外服那套, "自动"才看探测结果
  const { region, source: regionSource } = resolveRegion(config.ui?.region, detectedRegion);
  const profile = regionProfile(region);
  const base = await detectBaseLocale({
    finalDir: resolution.finalDir,
    leagueDir: resolution.leagueDir || null,
    configured: config.baseLocale,
    fallbackLocale: profile.fallbackBaseLocale
  });
  // 国服客户端被 ACE 保护, 进程路径读不到 —— 把已知目录交给凭据探测做日志回退
  setClientDirHint(resolution.leagueDir || null);
  logger.info(
    `渠道 ${profile.label}(${regionSource === "ui" ? "右上角按钮" : "按客户端路径探测"}) · 基准语种 ${base.locale}(${base.source}) · ${profile.detail}`
  );
  if (!voiceRootResolution.hasPacks) {
    logger.warn(`资源根目录下未发现任何语种包: ${voiceRootResolution.root}`);
  }
  return {
    config,
    appDir,
    voiceRoot: voiceRootResolution.root,
    voiceRootSource: voiceRootResolution.source,
    resolution,
    finalDir: resolution.finalDir,
    leagueDir: resolution.leagueDir || null,
    baseLocale: base.locale,
    baseLocaleSource: base.source,
    baseLocaleDetail: base.detail,
    region,
    regionSource,
    regionProfile: profile
  };
}

/** 模块执行上下文(带进度与取消)。 */
export interface ModuleRunOptions {
  progress?: import("../core/types.ts").ProgressReporter;
  signal?: AbortSignal;
}
