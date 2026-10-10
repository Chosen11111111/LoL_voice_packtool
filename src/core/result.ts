/**
 * 结构化结果: 每个模块的 apply/restore 都返回同一形状, 界面只认这一种。
 * 形状与旧版 Python 工具保持一致, 便于平滑替换。
 */
import type { ModuleId } from "./types.ts";

export const SLOT_MISSING_REASON = "目标槽位缺失";

export interface ModuleResult {
  ok: boolean;
  module: ModuleId | string;
  module_name: string;
  action: "apply" | "restore";
  planned: number;
  success: number;
  failed: number;
  missing: boolean;
  reason: string;
  message: string;
  errors: string[];
  detail?: Record<string, unknown>;
}

export interface ResultSummary {
  ok: boolean;
  partial: boolean;
  lines: string[];
  failed: string[];
}

export interface FailureItem {
  file: string;
  reason: string;
}

export interface MakeResultInput {
  action?: "apply" | "restore";
  planned?: number;
  success?: number;
  failed?: number;
  missing?: boolean;
  reason?: string;
  message?: string;
  errors?: string[];
  detail?: Record<string, unknown>;
}

export function makeResult(module: ModuleId | string, ok: boolean, input: MakeResultInput = {}): ModuleResult {
  const payload: ModuleResult = {
    ok: Boolean(ok),
    module,
    module_name: moduleName(module),
    action: input.action ?? "apply",
    planned: Math.trunc(input.planned ?? 0),
    success: Math.trunc(input.success ?? 0),
    failed: Math.trunc(input.failed ?? 0),
    missing: Boolean(input.missing),
    reason: input.reason ?? "",
    message: input.message ?? "",
    errors: (input.errors ?? []).map((item) => String(item)).slice(0, 5)
  };
  if (input.detail) payload.detail = input.detail;
  return payload;
}

const MODULE_NAMES: Record<string, string> = {
  ingame_voice: "游戏内语音",
  ingame_lang: "游戏内语言",
  lobby_voice: "大厅语音",
  lobby_lang: "大厅界面语言"
};

export function moduleName(module: ModuleId | string): string {
  return MODULE_NAMES[module] ?? String(module);
}

/** 把结果压成一行, 例如 '游戏内语音 0/174：资源缺失'。 */
export function formatResult(result: ModuleResult | null | undefined): string {
  if (!result) return "";
  const name = result.module_name || moduleName(result.module);
  let line = `${name} ${result.success}/${result.planned}`;
  const reason = String(result.reason ?? "").trim();
  if (reason) line += `：${reason}`;
  return line;
}

/** 汇总多模块结果: ok=全部成功, partial=有成功也有失败。 */
export function summarize(results: ModuleResult[]): ResultSummary {
  const items = results.filter((item): item is ModuleResult => Boolean(item));
  const failed = items.filter((item) => !item.ok);
  const ok = items.length > 0 && failed.length === 0;
  const partial = failed.length > 0 && items.some((item) => item.success > 0);
  return {
    ok,
    partial,
    lines: items.map((item) => formatResult(item)),
    failed: failed.map((item) => formatResult(item))
  };
}

/** 多条失败原因去重压缩成一句。 */
export function shortReason(failures: FailureItem[]): string {
  const reasons: string[] = [];
  for (const item of failures) {
    const reason = String(item.reason || "未知原因");
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  if (!reasons.length) return "";
  if (reasons.length === 1) return reasons[0]!;
  return `${reasons[0]} 等 ${reasons.length} 类原因`;
}

/** 目标槽位缺失的补充说明(游戏里本来没有这个文件, 新建也不会被加载)。 */
export function slotMissingNote(failures: FailureItem[]): string {
  const names = failures.filter((item) => item.reason === SLOT_MISSING_REASON).map((item) => item.file);
  if (!names.length) return "";
  const sample = names.slice(0, 3).join("、");
  return `（游戏内没有对应的国服文件：${sample}${names.length > 3 ? " 等" : ""}，新建文件不会被加载）`;
}
