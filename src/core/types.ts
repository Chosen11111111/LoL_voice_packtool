/** 跨模块共享的基础类型。 */
import type { ModuleResult } from "./result.ts";

export type ModuleId = "ingame_voice" | "ingame_lang" | "lobby_voice" | "lobby_lang";

export const SWITCH_MODULES: ModuleId[] = ["lobby_voice", "ingame_voice", "ingame_lang"];

export type ActionKind = "apply" | "restore";

export interface LocaleInfo {
  code: string;
  name: string;
  has_voice: boolean;
  has_lang: boolean;
  has_lobby: boolean;
  has_maps: boolean;
  voice_files: number;
  map_files: number;
  lang_files: number;
  lobby_files: number;
  root: string;
}

export interface ProgressReporter {
  (done: number, total: number, current?: string): void;
}

export interface ModuleContext {
  voiceRoot: string;
  finalDir: string | null;
  leagueDir: string | null;
  progress?: ProgressReporter;
  signal?: AbortSignal;
  /** 换肤插件同时开启时, 加载器沿用完整插件目录而不是精简的语音目录。 */
  skinsOn?: boolean;
}

export interface TaskOutcome {
  results: ModuleResult[];
  restarted?: boolean;
}
