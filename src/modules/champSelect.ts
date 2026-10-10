/**
 * 选人阶段的语音事件推导(纯逻辑, 不碰客户端)。
 *
 * 思路: 客户端自己的选人台词我们改不了(它对资源包有严格校验), 所以改成
 * **用 LCU 监听选人会话, 在工具里自己播语音包里的音频** —— 客户端一个字节都不用动。
 *
 * LCU 的 /lol-champ-select/v1/session 会给出当前会话: 每个玩家的 pick/ban 动作、
 * 悬停(未完成)与锁定(已完成)状态、本地玩家所在的 cellId。
 * 本模块把它翻译成"该播哪条语音"的事件序列。
 */
import type { ModuleId } from "../core/types.ts";

export type ChampSelectVoiceKind = "choose" | "ban";

export interface ChampSelectAction {
  id?: number;
  actorCellId: number;
  championId: number;
  type: string;
  completed: boolean;
  isInProgress?: boolean;
}

export interface ChampSelectSession {
  localPlayerCellId?: number;
  myTeam?: Array<{ cellId: number; championId: number; summonerId?: number }>;
  theirTeam?: Array<{ cellId: number; championId: number; summonerId?: number }>;
  actions?: ChampSelectAction[][];
  timer?: { phase?: string; adjustedTimeLeftInPhase?: number };
  gameId?: number;
}

export interface ChampSelectVoiceEvent {
  kind: ChampSelectVoiceKind;
  championId: number;
  phase: "hover" | "lock";
  actorCellId: number;
  /** 事件发生的时间戳(毫秒)。 */
  at: number;
}

export interface DeriveOptions {
  /** 是否也播其他玩家(对手/队友)的禁用台词, 默认只播自己的。 */
  includeOthers?: boolean;
  /** 同一英雄同一类型的最小重播间隔(毫秒), 默认 8000。 */
  repeatCooldownMs?: number;
  now?: number;
}

interface SeenRecord {
  at: number;
}

/** 记录"已经播过什么", 用于去重; 会话结束(换局)时清空。 */
export class ChampSelectTracker {
  private seen = new Map<string, SeenRecord>();
  private lastLocalPick = new Map<number, number>();
  private lastLocalBan = new Map<number, number>();

  reset(): void {
    this.seen.clear();
    this.lastLocalPick.clear();
    this.lastLocalBan.clear();
  }

  /**
   * 输入上一帧与当前帧, 输出这一帧应该播的语音。
   * 规则:
   *   - 只关心本地玩家自己的 pick / ban;
   *   - 悬停到新英雄 -> hover;直接锁定 -> lock(已经 hover 过同一英雄就不再播);
   *   - 同一英雄同一类型在冷却时间内不重复播。
   */
  derive(previous: ChampSelectSession | null, session: ChampSelectSession, options: DeriveOptions = {}): ChampSelectVoiceEvent[] {
    const now = options.now ?? Date.now();
    const cooldown = options.repeatCooldownMs ?? 8000;
    const localCell = session.localPlayerCellId ?? previous?.localPlayerCellId;
    if (localCell === undefined || localCell === null) return [];

    // 换局检测: gameId 变了就清空历史
    if (previous && previous.gameId !== undefined && session.gameId !== undefined && previous.gameId !== session.gameId) {
      this.reset();
    }

    const events: ChampSelectVoiceEvent[] = [];
    const actions = (session.actions ?? []).flat();

    const emit = (kind: ChampSelectVoiceKind, championId: number, phase: "hover" | "lock", actorCellId: number) => {
      const key = `${kind}:${championId}`;
      const record = this.seen.get(key);
      if (record && now - record.at < cooldown) return;
      this.seen.set(key, { at: now });
      events.push({ kind, championId, phase, actorCellId, at: now });
    };

    for (const action of actions) {
      const isLocal = action.actorCellId === localCell;
      if (!isLocal && !options.includeOthers) continue;
      if (!action.championId || action.championId <= 0) continue;
      const type = String(action.type || "").toLowerCase();
      const kind: ChampSelectVoiceKind | null = type === "ban" ? "ban" : type === "pick" || type === "ten_bans_reveal" ? "choose" : null;
      if (!kind) continue;

      const lastMap = kind === "choose" ? this.lastLocalPick : this.lastLocalBan;
      const previousChampion = lastMap.get(action.actorCellId) ?? 0;
      if (action.championId === previousChampion) continue; // 同一动作没有变化
      lastMap.set(action.actorCellId, action.championId);
      emit(kind, action.championId, action.completed ? "lock" : "hover", action.actorCellId);
    }

    return events;
  }
}

/** 事件 -> 语音包里的相对路径。 */
export function voiceRelativePath(kind: ChampSelectVoiceKind, championId: number): string {
  const dir = kind === "ban" ? "champion-ban-vo" : "champion-choose-vo";
  return `assets/${dir}/${championId}.ogg`;
}

/** 供界面/接口使用的模块标识。 */
export const CHAMP_SELECT_MODULE: ModuleId = "lobby_voice";
