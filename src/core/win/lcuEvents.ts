/**
 * LCU 选人会话监听(轮询实现, 零依赖)。
 *
 * 为什么用轮询: 只需要感知"悬停/锁定/禁用"这类秒级事件, 200ms 轮询足够;
 * 而 LCU 的 WebSocket 需要自定义 Authorization 头, Node 内置 WebSocket 支持有限,
 * 为一个播报功能引入 ws 依赖不值得。
 *
 * 端点: GET /lol-champ-select/v1/session
 *   200 -> 正在选人(返回会话)
 *   404 -> 不在选人流程
 *   0   -> 客户端没起来 / 拿不到凭据
 */
import { createLogger } from "../logger.ts";
import { lcuRequest } from "./lcu.ts";
import { isGameRunning } from "./processes.ts";
import type { ChampSelectSession } from "../../modules/champSelect.ts";

const logger = createLogger("lcu-events");

export type ChampSelectPresence = "in" | "out" | "offline";

export interface ChampSelectPoll {
  status: number;
  presence: ChampSelectPresence;
  /** 该次响应的摘要(排障: 看到底拿到了什么)。 */
  detail: string;
}

export interface WatchOptions {
  onSession: (session: ChampSelectSession, presence: ChampSelectPresence) => void;
  onPresence?: (presence: ChampSelectPresence) => void;
  /** 每次轮询(结果有变化时)回调, 用于排障。 */
  onPoll?: (poll: ChampSelectPoll) => void;
  /** 选人中的轮询间隔。 */
  fastIntervalMs?: number;
  /** 不在选人时的轮询间隔。 */
  idleIntervalMs?: number;
  /** 对局开始/结束时回调(让别处也能立刻停止请求)。 */
  onMatchChange?: (inMatch: boolean) => void;
  /** 对局中检查游戏进程的间隔(本地 tasklist, 不碰客户端)。 */
  matchCheckMs?: number;
}

/** 停止函数。 */
export type StopWatch = () => void;

export function watchChampSelect(options: WatchOptions): StopWatch {
  const fast = Math.max(100, options.fastIntervalMs ?? 200);
  const idle = Math.max(fast, options.idleIntervalMs ?? 1500);
  const matchCheck = Math.max(1000, options.matchCheckMs ?? 3000);
  let stopped = false;
  let lastPresence: ChampSelectPresence | null = null;
  /** 对局是否正在进行(用本地进程判断, 不发任何客户端请求)。 */
  let inMatch = false;
  let lastMatchCheck = 0;
  let lastPollKey = "";

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const report = (presence: ChampSelectPresence) => {
    if (presence !== lastPresence) {
      lastPresence = presence;
      logger.info(`选人流程状态变化: ${presence}`);
      options.onPresence?.(presence);
    }
  };

  const reportPoll = (poll: ChampSelectPoll) => {
    const key = `${poll.status}|${poll.presence}|${poll.detail}`;
    if (key === lastPollKey) return;
    lastPollKey = key;
    options.onPoll?.(poll);
  };

  void (async () => {
    while (!stopped) {
      // 对局中: 一个 LCU 请求都不发。
      // 判断"对局有没有结束"用本地进程检测(tasklist), 不产生任何客户端请求;
      // 选人阶段不必检测(那时游戏进程必然没起来), 省掉多余的系统调用。
      if (lastPresence !== "in" && Date.now() - lastMatchCheck >= matchCheck) {
        lastMatchCheck = Date.now();
        let running = false;
        try {
          running = await isGameRunning();
        } catch {
          running = false;
        }
        if (running !== inMatch) {
          inMatch = running;
          logger.info(running ? "检测到对局进程: 暂停一切客户端查询" : "对局结束: 恢复客户端查询");
          options.onMatchChange?.(running);
        }
      }
      if (inMatch) {
        await sleep(matchCheck);
        continue;
      }
      let presence: ChampSelectPresence = "offline";
      try {
        const response = await lcuRequest("GET", "/lol-champ-select/v1/session", { timeoutMs: 4000 });
        if (response.status === 200 && response.body) {
          presence = "in";
          let detail = "";
          try {
            const session = JSON.parse(response.body) as ChampSelectSession;
            const actions = (session.actions ?? []).flat();
            const mine = actions.filter((item) => item.actorCellId === session.localPlayerCellId);
            detail =
              `cell=${session.localPlayerCellId} 动作${actions.length} 自己的${mine.length}` +
              ` [${mine.map((item) => `${item.type}:${item.championId}${item.completed ? "✓" : ""}`).join(" ")}]`;
            reportPoll({ status: response.status, presence, detail });
            report(presence);
            if (!stopped) options.onSession(session, presence);
          } catch (error) {
            reportPoll({ status: response.status, presence, detail: "会话解析失败" });
            logger.debug(`选人会话解析失败: ${String((error as Error).message ?? error)}`);
          }
        } else if (response.status === 404) {
          presence = "out";
          reportPoll({ status: response.status, presence, detail: "不在选人" });
          report(presence);
          if (!stopped) options.onSession({}, presence);
        } else {
          presence = "offline";
          reportPoll({ status: response.status, presence, detail: response.status === 0 ? "拿不到客户端接口" : "非预期状态" });
          report(presence);
        }
      } catch (error) {
        reportPoll({ status: -1, presence: "offline", detail: String((error as Error).message ?? error).slice(0, 60) });
        logger.debug(`选人轮询异常: ${String((error as Error).message ?? error)}`);
      }
      await sleep(presence === "in" ? fast : idle);
    }
  })();

  return () => {
    stopped = true;
  };
}
