/**
 * 接管客户端自带的选人/禁用台词, 并提供音量对齐所需的客户端音量。
 *
 * 背景: 选人语音走的是"LCU 监听 + 本工具播放", 但客户端**自己也会念原版台词**,
 * 两路声音会叠在一起。客户端设置里有对应开关(LCU 的 lol-audio 命名空间):
 *
 *   pickChampVoEnabled = 播放选择语音   (选人时的英雄台词)
 *   banChampVoEnabled  = 播放禁用语音
 *
 * 关掉这两个, 客户端就不念原版台词了, 而**音效/音乐完全不受影响**
 * (总音量方案不同: masterVolume/sfxVolume 归零会把锁定音效和音乐一起弄没)。
 *
 * 闭环生命周期:
 *   1. 启动选人语音  -> 立即静音原版台词(禁用阶段来得很快, 不能等到进选人)
 *   2. 选人进行中    -> 保持静音(幂等)
 *   3. 选人结束/关闭 -> 写回原值
 * 原值在首次接管时记到 .tmp/client-voice-backup.json, 绝不凭空猜测。
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

/** 客户端音量(百分比, 取自 lol-audio 设置)。 */
export interface ClientVolumes {
  master: number;
  sfx: number;
  voice: number;
}

export interface ClientVoiceState {
  /** 客户端设置里有没有这两个键(有没有这个能力)。 */
  supported: boolean;
  /** 原版台词当前是否被静音(两个键都是 false)。 */
  suppressed: boolean;
  pick: boolean | null;
  ban: boolean | null;
  /** 本工具是否记录过原值(用于还原)。 */
  has_backup: boolean;
  client_running: boolean;
  /** 是否开启"选人期间自动静音"这套闭环。 */
  auto: boolean;
  /** 当前这次静音是不是本工具自动做的(用于决定是否自动还原)。 */
  suppressed_by_tool: boolean;
  volumes: ClientVolumes | null;
  /** 按客户端音量算出的播报音量建议值(百分比), 客户端没开时为 null。 */
  aligned_volume: number | null;
  message: string;
}

interface Backup {
  pick?: boolean;
  ban?: boolean;
  at: string;
}

interface AutoState {
  auto: boolean;
  suppressedByTool: boolean;
}

function backupFile(): string {
  return path.join(appRoot(), ".tmp", "client-voice-backup.json");
}

function autoFile(): string {
  return path.join(appRoot(), ".tmp", "client-voice-auto.json");
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
  return data[PICK_KEY] === false && data[BAN_KEY] === false;
}

/** 判断客户端支不支持这两个开关。 */
export function supportsVoiceToggles(data: Record<string, unknown> | null | undefined): boolean {
  if (!data) return false;
  return PICK_KEY in data || BAN_KEY in data;
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 从设置里取客户端音量(缺省按客户端默认值处理)。 */
export function readVolumes(data: Record<string, unknown> | null | undefined): ClientVolumes | null {
  if (!data) return null;
  return {
    master: numberOr(data["masterVolume"], 100),
    sfx: numberOr(data["sfxVolume"], 100),
    voice: numberOr(data["voiceVolume"], 100)
  };
}

/**
 * 播报音量对齐: 直接用客户端的**总音量**。
 *
 * 之前用"总音量 × 音效"的乘积, 用户看到的是 85 而工具显示 28(x 音效 33), 对不上号 ——
 * 播报来自另一个进程, 本来就不经过客户端的混音链路, 用总音量最直观也最好解释。
 */
export function computeAlignedVolume(volumes: ClientVolumes | null): number | null {
  if (!volumes) return null;
  return Math.max(5, Math.min(100, Math.round(volumes.master)));
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
  } catch (error) {
    logger.warn(`写入 ${path.basename(file)} 失败: ${String((error as Error).message ?? error)}`);
  }
}

async function readAuto(): Promise<AutoState> {
  const state = await readJson<AutoState>(autoFile());
  return { auto: state?.auto ?? true, suppressedByTool: Boolean(state?.suppressedByTool) };
}

async function writeAuto(state: AutoState): Promise<void> {
  await writeJson(autoFile(), state);
}

/** 当前状态(供界面与接口使用)。 */
export async function clientVoiceState(): Promise<ClientVoiceState> {
  const settings = await readAudioSettings();
  const backup = await readJson<Backup>(backupFile());
  const auto = await readAuto();
  if (!settings) {
    return {
      supported: false,
      suppressed: false,
      pick: null,
      ban: null,
      has_backup: Boolean(backup),
      client_running: false,
      auto: auto.auto,
      suppressed_by_tool: auto.suppressedByTool,
      volumes: null,
      aligned_volume: null,
      message: "拿不到客户端设置（客户端没在运行？）"
    };
  }
  const pick = settings.data[PICK_KEY];
  const ban = settings.data[BAN_KEY];
  const suppressed = deriveSuppressed(settings.data);
  const volumes = readVolumes(settings.data);
  return {
    supported: supportsVoiceToggles(settings.data) || suppressed,
    suppressed,
    pick: typeof pick === "boolean" ? pick : null,
    ban: typeof ban === "boolean" ? ban : null,
    has_backup: Boolean(backup),
    client_running: true,
    auto: auto.auto,
    suppressed_by_tool: auto.suppressedByTool,
    volumes,
    aligned_volume: computeAlignedVolume(volumes),
    message: suppressed ? "客户端原版台词已静音（音效与音乐不受影响）" : "客户端原版台词开启中"
  };
}

/**
 * 静音/恢复客户端的原版选人台词。
 * 静音时把两个键写为 false 并记下原值; 恢复时写回原值(没有记录就按默认开启处理)。
 */
export async function setClientOriginalVoice(
  suppress: boolean,
  origin: "tool" | "user" = "user"
): Promise<{ ok: boolean; message: string; state: ClientVoiceState }> {
  const settings = await readAudioSettings();
  if (!settings) {
    return { ok: false, message: "拿不到客户端设置，请确认客户端正在运行", state: await clientVoiceState() };
  }

  if (suppress && !(await readJson<Backup>(backupFile()))) {
    // 只在第一次接管时记录原值, 之后重复开启不会覆盖真正的最初状态
    const backup: Backup = {
      pick: typeof settings.data[PICK_KEY] === "boolean" ? (settings.data[PICK_KEY] as boolean) : true,
      ban: typeof settings.data[BAN_KEY] === "boolean" ? (settings.data[BAN_KEY] as boolean) : true,
      at: new Date().toISOString()
    };
    await writeJson(backupFile(), backup);
  }

  const backup = await readJson<Backup>(backupFile());
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

  const auto = await readAuto();
  const suppressedByTool = suppress ? origin === "tool" || auto.suppressedByTool : false;
  await writeAuto({ auto: auto.auto, suppressedByTool });
  const state = await clientVoiceState();
  logger.info(suppress ? `已静音客户端原版选人台词（${origin === "tool" ? "自动" : "手动"}）` : "已恢复客户端原版选人台词");
  return { ok: true, message: state.message, state };
}

/** 开启/关闭"选人期间自动静音"闭环(关闭时立即还原自动做的静音)。 */
export async function setAutoSuppress(enabled: boolean): Promise<{ ok: boolean; message: string; state: ClientVoiceState }> {
  const auto = await readAuto();
  await writeAuto({ auto: enabled, suppressedByTool: auto.suppressedByTool });
  if (!enabled) {
    if (auto.suppressedByTool) {
      const restored = await setClientOriginalVoice(false, "tool");
      return { ok: true, message: "已关闭自动静音，并还原了客户端原版台词", state: restored.state };
    }
    return { ok: true, message: "已关闭自动静音", state: await clientVoiceState() };
  }
  return { ok: true, message: "已开启：选人期间自动静音客户端原版台词", state: await clientVoiceState() };
}

/** 进入/保持在选人流程: 按闭环设置静音原版台词(幂等)。 */
export async function suppressForChampSelect(): Promise<void> {
  const auto = await readAuto();
  if (!auto.auto) return;
  const settings = await readAudioSettings();
  if (!settings) return;
  if (deriveSuppressed(settings.data)) {
    if (!auto.suppressedByTool) await writeAuto({ auto: true, suppressedByTool: true });
    return;
  }
  const result = await setClientOriginalVoice(true, "tool");
  if (!result.ok) logger.warn(`自动静音原版台词失败: ${result.message}`);
}

/**
 * 启动兜底: 如果上次是工具自动静音的, 但这次工具启动时并没有在监听选人语音,
 * 就把原版台词还原回去 —— 否则客户端设置会一直留在"静音"状态(它是持久化的)。
 */
export async function recoverOnStartup(listening: boolean): Promise<void> {
  const auto = await readAuto();
  if (!auto.suppressedByTool) return;
  if (listening) return;
  const settings = await readAudioSettings();
  if (!settings) {
    // 客户端没开: 保留标记, 等客户端起来后再还原(见下方 noteSuppressed 状态的保留)
    logger.info("上次静音过客户端原版台词，但客户端未运行，稍后再还原");
    return;
  }
  const result = await setClientOriginalVoice(false, "tool");
  logger.info(result.ok ? "启动兜底: 已还原客户端原版台词" : `启动兜底还原失败: ${result.message}`);
}

/** 选人结束/关闭功能: 还原原版台词。 */
export async function restoreAfterChampSelect(reason: string): Promise<void> {
  const auto = await readAuto();
  if (!auto.auto || !auto.suppressedByTool) return;
  const result = await setClientOriginalVoice(false, "tool");
  if (result.ok) {
    logger.info(`原版台词已还原（${reason}）`);
  } else {
    logger.warn(`还原原版台词失败: ${result.message}`);
  }
}
