/**
 * 选人语音实时播报(LCU 监听 + 本地播放)。
 *
 * 背景: 客户端资源包 (<语种>-assets.wad) 有严格的内容校验, 改不了 —— 实测连
 * "数据一字不改、只挪偏移" 都会被判损坏。所以选人台词改成这条链路:
 *
 *   LCU 监听选人会话 -> 推导该播哪条 -> 把语音包里的 ogg 交给播放端(工具窗口里的 <audio>)
 *
 * 客户端完全不用动, 界面语言也不受影响。
 */
import path from "node:path";
import { createLogger } from "../core/logger.ts";
import { isDirectory, isFile } from "../core/fsx.ts";
import { watchChampSelect, type ChampSelectPresence, type StopWatch } from "../core/win/lcuEvents.ts";
import { ChampSelectTracker, voiceRelativePath, type ChampSelectSession, type ChampSelectVoiceEvent } from "./champSelect.ts";

const logger = createLogger("lobby-live");

export interface LobbyLiveEvent extends ChampSelectVoiceEvent {
  /** 播放地址(由本工具的后端提供)。 */
  url: string;
  locale: string;
}

export interface LobbyLiveOptions {
  voiceRoot: string;
  locale: string;
  /** 是否也播别人的禁用/选人台词。 */
  includeOthers?: boolean;
  /** 轮询间隔(测试用)。 */
  fastIntervalMs?: number;
  idleIntervalMs?: number;
  /** 会话来源可注入(测试用)。 */
  watcher?: (options: Parameters<typeof watchChampSelect>[0]) => StopWatch;
}

export interface LobbyLiveState {
  running: boolean;
  locale: string;
  include_others: boolean;
  presence: ChampSelectPresence;
  /** 本地语音包里该语种的音频数量。 */
  available: number;
  played: number;
  last_event: LobbyLiveEvent | null;
  history: LobbyLiveEvent[];
  message: string;
}

type Listener = (event: LobbyLiveEvent) => void;

const HISTORY_LIMIT = 12;

export class LobbyLiveEngine {
  private stopWatch: StopWatch | null = null;
  private tracker = new ChampSelectTracker();
  private listeners = new Set<Listener>();
  private options: LobbyLiveOptions | null = null;
  private presence: ChampSelectPresence = "offline";
  private available = 0;
  private played = 0;
  private history: LobbyLiveEvent[] = [];
  private message = "未启动";

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isRunning(): boolean {
    return this.stopWatch !== null;
  }

  /** 统计语音包里该语种可用的选人/禁用音频数量。 */
  private async countAvailable(voiceRoot: string, locale: string): Promise<number> {
    let total = 0;
    for (const dir of ["champion-choose-vo", "champion-ban-vo"]) {
      const full = path.join(voiceRoot, locale, "assets", dir);
      if (!(await isDirectory(full))) continue;
      const files = await import("../core/fsx.ts").then((module) => module.walkFiles(full, { match: (name) => name.endsWith(".ogg") }));
      total += files.length;
    }
    return total;
  }

  async start(options: LobbyLiveOptions): Promise<{ ok: boolean; message: string; state: LobbyLiveState }> {
    await this.stop();
    const chooseDir = path.join(options.voiceRoot, options.locale, "assets", "champion-choose-vo");
    if (!(await isDirectory(chooseDir))) {
      this.message = `语音包里没有 ${options.locale} 的选人语音：${chooseDir}`;
      return { ok: false, message: this.message, state: this.state() };
    }
    this.available = await this.countAvailable(options.voiceRoot, options.locale);
    this.options = options;
    this.tracker = new ChampSelectTracker();
    this.presence = "offline";
    this.played = 0;
    this.history = [];
    const watch = options.watcher ?? watchChampSelect;
    this.stopWatch = watch({
      fastIntervalMs: options.fastIntervalMs,
      idleIntervalMs: options.idleIntervalMs,
      onPresence: (presence) => {
        this.presence = presence;
        if (presence !== "in") this.tracker.reset();
      },
      onSession: (session) => this.handleSession(session)
    });
    this.message = `正在监听选人流程，使用 ${options.locale} 的语音包（${this.available} 个音频）`;
    logger.info(this.message);
    return { ok: true, message: this.message, state: this.state() };
  }

  private handleSession(session: ChampSelectSession): void {
    const options = this.options;
    if (!options) return;
    const events = this.tracker.derive(null, session, { includeOthers: options.includeOthers });
    for (const event of events) {
      const payload: LobbyLiveEvent = {
        ...event,
        locale: options.locale,
        url: `/api/lobby-audio/${event.kind}/${event.championId}.ogg?locale=${encodeURIComponent(options.locale)}`
      };
      this.played += 1;
      this.history = [payload, ...this.history].slice(0, HISTORY_LIMIT);
      logger.info(`播放 ${event.kind} 台词: 英雄 ${event.championId}（${event.phase}）`);
      for (const listener of this.listeners) {
        try {
          listener(payload);
        } catch (error) {
          logger.debug(`播报订阅者异常: ${String((error as Error).message ?? error)}`);
        }
      }
    }
  }

  /** 校验某个事件对应的音频是否真的存在(前端播放前可先问一次)。 */
  async resolveAudio(kind: "choose" | "ban", championId: number, locale: string): Promise<string | null> {
    const options = this.options;
    const root = options?.voiceRoot;
    if (!root) return null;
    const relative = voiceRelativePath(kind, championId);
    const full = path.join(root, locale, relative);
    return (await isFile(full)) ? full : null;
  }

  async stop(): Promise<void> {
    if (this.stopWatch) {
      this.stopWatch();
      this.stopWatch = null;
    }
    this.options = null;
    this.presence = "offline";
    this.tracker.reset();
    this.message = "已停止监听";
  }

  state(): LobbyLiveState {
    return {
      running: this.isRunning(),
      locale: this.options?.locale ?? "",
      include_others: Boolean(this.options?.includeOthers),
      presence: this.presence,
      available: this.available,
      played: this.played,
      last_event: this.history[0] ?? null,
      history: this.history,
      message: this.message
    };
  }
}

export const lobbyLive = new LobbyLiveEngine();
