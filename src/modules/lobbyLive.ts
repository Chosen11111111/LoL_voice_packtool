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
import { recoverOnStartup, restoreAfterChampSelect, suppressForChampSelect } from "./clientVoice.ts";
import { isClientRunning } from "../core/win/processes.ts";
import {
  ChampSelectTracker,
  VOICE_TRIGGER,
  voiceRelativePath,
  type ChampSelectSession,
  type ChampSelectVoiceEvent
} from "./champSelect.ts";

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
  /** 客户端是否在运行(可注入, 便于测试)。 */
  clientRunning?: () => Promise<boolean>;
}

export interface PlaybackReport {
  at: number;
  ok: boolean;
  error: string;
  detail: string;
  kind: "choose" | "ban";
  championId: number;
}

export interface LobbyLiveState {
  running: boolean;
  locale: string;
  include_others: boolean;
  trigger: string;
  presence: ChampSelectPresence;
  /** 本地语音包里该语种的音频数量。 */
  available: number;
  played: number;
  last_event: LobbyLiveEvent | null;
  history: LobbyLiveEvent[];
  /** 最近一次选人会话摘要(排障用)。 */
  last_session: Record<string, unknown> | null;
  /** 最近的会话快照序列(排障: 看悬停/锁定是怎么变化的)。 */
  session_log: Array<Record<string, unknown>>;
  /** 轮询轨迹(排障: 每次结果变化时记一条)。 */
  poll_log: string[];
  /** 窗口回报的最近一次播放结果(排障用)。 */
  last_playback: PlaybackReport | null;
  playback_ok: number;
  playback_failed: number;
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
  /** 最近一次选人会话摘要(排障用: 看客户端到底给了什么结构)。 */
  private lastSession: Record<string, unknown> | null = null;
  private sessionLog: Array<Record<string, unknown>> = [];
  private pollLog: string[] = [];
  /** 本轮选人是否已经建立基线(建立后才有事件)。 */
  private baselined = false;
  /** 当前是否处于选人流程(用于判断"选人结束"从而还原原版台词)。 */
  private inChampSelect = false;
  /** 窗口回报的播放结果。 */
  private lastPlayback: PlaybackReport | null = null;
  private playbackOk = 0;
  private playbackFailed = 0;

  /** 接收窗口的播放结果上报。 */
  reportPlayback(report: Omit<PlaybackReport, "at">): void {
    this.lastPlayback = { ...report, at: Date.now() };
    if (report.ok) this.playbackOk += 1;
    else {
      this.playbackFailed += 1;
      logger.warn(`窗口播放失败: ${report.error} ${report.detail}`);
    }
  }

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
    // 已经在用同一个语种监听: 直接返回, 不重启(重启会重新建基线, 也不会重播)
    if (this.stopWatch && this.options?.locale === options.locale && Boolean(this.options?.includeOthers) === Boolean(options.includeOthers)) {
      return { ok: true, message: this.message, state: this.state() };
    }
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
    this.lastPlayback = null;
    this.playbackOk = 0;
    this.playbackFailed = 0;
    this.sessionLog = [];
    this.pollLog = [];
    this.lastSession = null;
    this.baselined = false;
    this.inChampSelect = false;
    const watch = options.watcher ?? watchChampSelect;
    this.stopWatch = watch({
      fastIntervalMs: options.fastIntervalMs,
      idleIntervalMs: options.idleIntervalMs,
      onPresence: (presence) => {
        this.presence = presence;
        if (presence === "in") {
          this.inChampSelect = true;
          // 进入/保持在选人: 按闭环确保客户端原版台词是静音的(幂等)
          void suppressForChampSelect();
        } else {
          // 离开选人: 清空去重状态, 下一局重新建基线
          this.tracker.reset();
          this.baselined = false;
          // 只有"真的从选人里出来"才还原原版台词(启动时第一次收到 out 不算)
          if (this.inChampSelect) {
            this.inChampSelect = false;
            void restoreAfterChampSelect("选人结束");
          }
        }
      },
      onPoll: (poll) => {
        const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
        this.pollLog = [`${stamp} [${poll.presence}] status=${poll.status} ${poll.detail}`, ...this.pollLog].slice(0, 40);
      },
      onSession: (session, presence) => this.handleSession(session, presence)
    });
    // 客户端没启动时: 照常待机等待(客户端起来后进选人会自动接管), 但不假装已经生效
    const clientRunning = await (options.clientRunning ?? isClientRunning)();
    this.message = clientRunning
      ? `正在监听选人流程，使用 ${options.locale} 的语音包（${this.available} 个音频，锁定才播）`
      : `英雄联盟未启动：已待机等待，客户端启动后进选人会自动接管（${options.locale}，${this.available} 个音频）`;
    logger.info(this.message);
    // 闭环第 1 步: 只有客户端在运行才去静音原版台词(禁用阶段来得很快, 不能等到进选人)
    if (clientRunning) {
      void suppressForChampSelect();
    } else {
      // 客户端没开时顺便兜底: 上次工具静音过的话, 等客户端起来再还原
      void recoverOnStartup(true);
    }
    return { ok: true, message: this.message, state: this.state() };
  }

  private handleSession(session: ChampSelectSession, presence: ChampSelectPresence): void {
    const options = this.options;
    if (!options) return;
    // 只在"正在选人"时记录会话摘要(404 时空会话会覆盖掉有用的诊断信息)
    if (presence === "in") {
      const actions = (session.actions ?? []).flat();
      const mine = (session.myTeam ?? []).find((item) => item.cellId === session.localPlayerCellId);
      const snapshot: Record<string, unknown> = {
        at: new Date().toISOString().slice(11, 19),
        localPlayerCellId: session.localPlayerCellId,
        gameId: session.gameId,
        timer_phase: session.timer?.phase,
        my_team_champion: mine?.championId ?? 0,
        action_count: actions.length,
        actions: actions.slice(0, 12).map((item) => ({
          actorCellId: item.actorCellId,
          championId: item.championId,
          type: item.type,
          completed: item.completed,
          isInProgress: item.isInProgress
        }))
      };
      this.lastSession = snapshot;
      const previous = this.sessionLog[0];
      if (!previous || JSON.stringify({ ...previous, at: 0 }) !== JSON.stringify({ ...snapshot, at: 0 })) {
        this.sessionLog = [snapshot, ...this.sessionLog].slice(0, 10);
      }
    }
    // 刚进入选人(或刚重启监听)时先建立基线: 已经锁好的英雄不再补播
    if (!this.baselined) {
      this.tracker.baseline(session);
      this.baselined = true;
      const lockedNow = (session.actions ?? []).flat().filter((item) => item.completed && item.championId > 0);
      logger.info(
        lockedNow.length
          ? `建立基线: 已经锁定的 ${lockedNow.map((item) => item.championId).join(",")} 不补播`
          : "建立基线: 当前还没有锁定动作"
      );
      return;
    }
    const events = this.tracker.derive(null, session, { includeOthers: options.includeOthers });
    for (const event of events) {
      const payload: LobbyLiveEvent = {
        ...event,
        locale: options.locale,
        url: `/api/lobby-audio/${event.kind}/${event.championId}.ogg?locale=${encodeURIComponent(options.locale)}`
      };
      this.played += 1;
      this.history = [payload, ...this.history].slice(0, HISTORY_LIMIT);
      logger.info(`播放 ${event.kind} 台词: 英雄 ${event.championId}（${event.phase}，来源 ${event.source ?? "?"}）`);
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
      // 闭环第 3 步: 关闭功能时还原原版台词
      void restoreAfterChampSelect("关闭选人语音");
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
      trigger: VOICE_TRIGGER,
      presence: this.presence,
      available: this.available,
      played: this.played,
      last_event: this.history[0] ?? null,
      history: this.history,
      last_session: this.lastSession,
      session_log: this.sessionLog,
      poll_log: this.pollLog,
      last_playback: this.lastPlayback,
      playback_ok: this.playbackOk,
      playback_failed: this.playbackFailed,
      message: this.message
    };
  }
}

export const lobbyLive = new LobbyLiveEngine();
