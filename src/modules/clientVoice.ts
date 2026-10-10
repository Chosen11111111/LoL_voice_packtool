/**
 * 接管客户端自带的选人/禁用台词。
 *
 * 背景: 选人语音走的是"LCU 监听 + 本工具播放", 但客户端**自己也会念原版台词**,
 * 两路声音会叠在一起。客户端设置里有对应开关(LCU 的 lol-audio 命名空间):
 *
 *   pickChampVoEnabled = 播放选择语音   (选人时的英雄台词)
 *   banChampVoEnabled  = 播放禁用语音
 *
 * 关掉这两个, 客户端就不念原版台词了, 而**音效/音乐完全不受影响**(与被验证过的
 * 总音量方案不同, 那个会把锁定音效和音乐一起弄没)。
 * 这里提供"静音原版"的开关, 并保存原值以便还原。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { appRoot } from "../core/config.ts";
import { createLogger } from "../core/logger.ts";
import { lcuRequest } from "../core/win/lcu.ts";

const logger = createLogger("client-voice");
const NAMESPACE = "lol-audio";
const SETTINGS_PATH = `/lol-settings/v2/local/${NAMESPACE}`;

/** 开启/关闭原版台词的键(客户端 schema 里的名字)。 */
export const PICK_KEY = "pickChampVoEnabled";
export const BAN_KEY = "banChampVoEnabled";

export interface AudioSettings {
  data: Record<string, unknown>;
  schemaVersion: number;
}

export interface ClientVoiceState {
  /** 客户端设置里有没有这两个键(有没有这个能力)。 */
  supported: boolean;
  /** 原版台词是否已被静音(两个键都是 false)。 */
  suppressed: boolean;
  pick: boolean | null;
  ban: boolean | null;
  /** 本工具是否记录过原值(用于还原)。 */
  has_backup: boolean;
  client_running: boolean;
  message: string;
}

function backupFile(): string {
  return path.join(appRoot(), ".tmp", "client-voice-backup.json");
}

/** 读取客户端音频设置(客户端没运行时返回 null)。 */
export async function readAudioSettings(): Promise<AudioSettings | null> {
  const response = await lcuRequest("GET", SETTINGS_PATH, { timeoutMs: 6000 });
  if (response.status !== 200 || !response.body) return null;
  try {
    const parsed = JSON.parse(response.body) as AudioSettings;
    if (!parsed || typeof parsed !== "object" || typeof parsed.data !== "object" || !parsed.data) return null;
    return { data: parsed.data, schemaVersion: Number(parsed.schemaVersion) || 5 };
  } catch {
    return null;
  }
}

/** 从设置数据推导"原版台词是否被静音"(纯函数, 便于测试)。 */
export function deriveSuppressed(data: Record<string, unknown> | null | undefined): boolean {
  if (!data) return false;
  const pick = data[PICK_KEY];
  const ban = data[BAN_KEY];
  // 两个键都显式关掉才算静音(缺省时客户端默认是开启的)
  return pick === false && ban === false;
}

/** 判断客户端支不支持这两个开关。 */
export function supportsVoiceToggles(data: Record<string, unknown> | null | undefined): boolean {
  if (!data) return false;
  return PICK_KEY in data || BAN_KEY in data;
}

interface Backup {
  pick?: boolean;
  ban?: boolean;
  at: string;
}

async function readBackup(): Promise<Backup | null> {
  try {
    return JSON.parse(await fs.readFile(backupFile(), "utf8")) as Backup;
  } catch {
    return null;
  }
}

/** 当前状态(供界面与接口使用)。 */
export async function clientVoiceState(): Promise<ClientVoiceState> {
  const settings = await readAudioSettings();
  const backup = await readBackup();
  if (!settings) {
    return {
      supported: false,
      suppressed: false,
      pick: null,
      ban: null,
      has_backup: Boolean(backup),
      client_running: false,
      message: "拿不到客户端设置（客户端没在运行？）"
    };
  }
  const pick = settings.data[PICK_KEY];
  const ban = settings.data[BAN_KEY];
  const suppressed = deriveSuppressed(settings.data);
  return {
    supported: supportsVoiceToggles(settings.data) || !suppressed,
    suppressed,
    pick: typeof pick === "boolean" ? pick : null,
    ban: typeof ban === "boolean" ? ban : null,
    has_backup: Boolean(backup),
    client_running: true,
    message: suppressed ? "客户端原版台词已静音（音效与音乐不受影响）" : "客户端原版台词开启中"
  };
}

/**
 * 静音/恢复客户端的原版选人台词。
 * 静音时把两个键写为 false 并记下原值; 恢复时写回原值(没有记录就按默认开启处理)。
 */
export async function setClientOriginalVoice(suppress: boolean): Promise<{ ok: boolean; message: string; state: ClientVoiceState }> {
  const settings = await readAudioSettings();
  if (!settings) {
    return { ok: false, message: "拿不到客户端设置，请确认客户端正在运行", state: await clientVoiceState() };
  }

  if (suppress && !(await readBackup())) {
    // 只在第一次接管时记录原值, 之后重复开启不会覆盖真正的最初状态
    const backup: Backup = {
      pick: typeof settings.data[PICK_KEY] === "boolean" ? (settings.data[PICK_KEY] as boolean) : true,
      ban: typeof settings.data[BAN_KEY] === "boolean" ? (settings.data[BAN_KEY] as boolean) : true,
      at: new Date().toISOString()
    };
    try {
      await fs.mkdir(path.dirname(backupFile()), { recursive: true });
      await fs.writeFile(backupFile(), JSON.stringify(backup, null, 2), "utf8");
    } catch (error) {
      logger.warn(`原值记录失败(仍会继续静音): ${String((error as Error).message ?? error)}`);
    }
  }

  const backup = await readBackup();
  const next: Record<string, unknown> = { ...settings.data };
  if (suppress) {
    next[PICK_KEY] = false;
    next[BAN_KEY] = false;
  } else {
    next[PICK_KEY] = backup?.pick ?? true;
    next[BAN_KEY] = backup?.ban ?? true;
  }

  const response = await lcuRequest("PATCH", SETTINGS_PATH, {
    timeoutMs: 8000,
    body: JSON.stringify({ data: next, schemaVersion: settings.schemaVersion })
  });
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      message: `写入客户端设置失败（HTTP ${response.status}）：${response.body.slice(0, 120)}`,
      state: await clientVoiceState()
    };
  }

  const state = await clientVoiceState();
  logger.info(suppress ? "已静音客户端原版选人台词" : "已恢复客户端原版选人台词");
  return { ok: true, message: state.message, state };
}
