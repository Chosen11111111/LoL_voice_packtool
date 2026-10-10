/**
 * 对局端替换计划的执行器: 预检目标槽位 -> 逐文件安全替换 -> 统计 planned/success/failed。
 *
 * 为什么先预检槽位: 游戏里本来就没有的 .zh_CN 文件, 新建出来也不会被加载,
 * 直接算"替换成功"会让用户以为生效了。这类记为"目标槽位缺失"。
 */
import path from "node:path";
import { backupPath, pathExists, replaceFile, targetDirState } from "../core/fsx.ts";
import { makeResult, shortReason, slotMissingNote, SLOT_MISSING_REASON, type FailureItem, type ModuleResult } from "../core/result.ts";
import type { ModuleId, ProgressReporter } from "../core/types.ts";
import { localeDisplayName } from "../packs/locales.ts";
import { targetFileName } from "../packs/wad.ts";

export interface PlanGroup {
  name: string;
  sources: string[];
  destDir: string;
}

export interface ApplyPlanOptions {
  description: string;
  progress?: ProgressReporter;
  signal?: AbortSignal;
  /** 目标槽位后缀(默认国服 .zh_CN.wad.client, 国际服按客户端实际语种)。 */
  baseSuffix?: string;
}

export async function applyPlan(
  module: ModuleId,
  locale: string,
  groups: PlanGroup[],
  options: ApplyPlanOptions
): Promise<ModuleResult> {
  const suffix = options.baseSuffix || ".zh_CN.wad.client";
  const planTotal = groups.reduce((sum, group) => sum + group.sources.length, 0);
  const failures: FailureItem[] = [];
  let success = 0;
  let done = 0;
  let cancelled = false;

  options.progress?.(0, planTotal);

  for (const group of groups) {
    if (!group.sources.length) continue;
    const [usable, why] = await targetDirState(group.destDir);
    if (!usable) {
      for (const src of group.sources) {
        done += 1;
        failures.push({ file: targetFileName(src, suffix), reason: why });
        options.progress?.(done, planTotal, targetFileName(src, suffix));
      }
      continue;
    }
    for (const src of group.sources) {
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }
      const dst = path.join(group.destDir, targetFileName(src, suffix));
      done += 1;
      // 目标槽位必须是游戏里本来就有的(备份还在也算: 说明只是当前文件缺了, 可以补回)
      if (!(await pathExists(dst)) && !(await pathExists(backupPath(dst)))) {
        failures.push({ file: path.basename(dst), reason: SLOT_MISSING_REASON });
        options.progress?.(done, planTotal, path.basename(dst));
        continue;
      }
      const [ok, reason] = await replaceFile(src, dst);
      if (ok) success += 1;
      else failures.push({ file: path.basename(dst), reason });
      options.progress?.(done, planTotal, path.basename(dst));
    }
    if (cancelled) break;
  }

  const locName = localeDisplayName(locale);
  if (cancelled) {
    return makeResult(module, false, {
      planned: planTotal,
      success,
      failed: failures.length,
      reason: "已取消",
      message: `已取消：${options.description} 完成 ${success}/${planTotal}`,
      errors: failures.map((item) => `${item.file}: ${item.reason}`),
      detail: { plan: planTotal, success, failed: failures.length, cancelled: true }
    });
  }
  if (!failures.length && success > 0) {
    return makeResult(module, true, {
      planned: planTotal,
      success,
      failed: 0,
      message: `${options.description} ${success}/${planTotal} 已切换为 ${locName}`,
      detail: { plan: planTotal, success, failed: 0 }
    });
  }
  if (!failures.length) {
    return makeResult(module, false, {
      planned: planTotal,
      success: 0,
      failed: 0,
      missing: true,
      reason: "资源缺失",
      message: `未找到可匹配的 ${locale} 资源文件`
    });
  }
  const reason = shortReason(failures);
  const note = slotMissingNote(failures);
  return makeResult(module, false, {
    planned: planTotal,
    success,
    failed: failures.length,
    reason: `替换失败 ${failures.length} 个：${reason}`,
    message: `${locName} 替换失败 ${failures.length} 个：${reason}${note}`,
    errors: failures.map((item) => `${item.file}: ${item.reason}`),
    detail: { plan: planTotal, success, failed: failures.length }
  });
}
