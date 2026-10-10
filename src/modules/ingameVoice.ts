/** 对局端: 英雄台词与系统播报员语音切换/还原。 */
import path from "node:path";
import { cleanPartialBackups, pathExists, removeQuietly, restoreFileVerbose, walkFiles } from "../core/fsx.ts";
import { makeResult, shortReason, type FailureItem, type ModuleResult } from "../core/result.ts";
import type { ModuleContext } from "../core/types.ts";
import { isGameRunning } from "../core/win/processes.ts";
import { checkModuleResources, destSlotCount } from "../packs/inventory.ts";
import { voiceGroups } from "../packs/wad.ts";
import { applyPlan } from "./applyPlan.ts";

const MODULE = "ingame_voice" as const;

/** 切换英雄语音与播报员为指定语种。 */
export async function applyIngameVoice(locale: string, context: ModuleContext): Promise<ModuleResult> {
  if (await isGameRunning()) {
    return makeResult(MODULE, false, {
      reason: "对局中",
      message: "检测到英雄联盟游戏对局进程 (League of Legends.exe) 正在运行，请退出对局后再切换。"
    });
  }
  if (!context.finalDir) {
    return makeResult(MODULE, false, { reason: "游戏路径未就绪", message: "未能解析游戏文件目录 Game\\DATA\\FINAL。" });
  }

  const groups = await voiceGroups(locale, context.voiceRoot, context.finalDir);
  const sources = groups.reduce((sum, group) => sum + group.sources.length, 0);
  if (!sources) {
    const [champSlots, mapSlots] = await Promise.all([
      destSlotCount(path.join(context.finalDir, "Champions")),
      destSlotCount(path.join(context.finalDir, "Maps", "Shipping"))
    ]);
    const slots = champSlots + mapSlots;
    const resFinal = path.join(context.voiceRoot, locale, "DATA", "FINAL");
    return makeResult(MODULE, false, {
      planned: slots,
      success: 0,
      failed: slots,
      missing: true,
      reason: "资源缺失",
      message:
        `未找到可匹配的 ${locale} 英雄语音或系统播报员文件（仅有大厅选人语音的包不能用于对局语音）。\n` +
        `期望目录：${path.join(resFinal, "Champions")} 或 ${path.join(resFinal, "Maps", "Shipping")}`
    });
  }

  return applyPlan(MODULE, locale, groups, {
    description: "游戏内语音",
    progress: context.progress,
    signal: context.signal
  });
}

/** 还原英雄语音与播报员为国服原版。 */
export async function restoreIngameVoice(context: ModuleContext): Promise<ModuleResult> {
  if (await isGameRunning()) {
    return makeResult(MODULE, false, {
      action: "restore",
      reason: "对局中",
      message: "检测到英雄联盟游戏对局进程正在运行，请退出对局后再还原。"
    });
  }
  if (!context.finalDir) {
    return makeResult(MODULE, false, { action: "restore", reason: "游戏路径未就绪", message: "未能解析游戏文件目录 Game\\DATA\\FINAL。" });
  }

  const directories = [path.join(context.finalDir, "Champions"), path.join(context.finalDir, "Maps", "Shipping")];
  let partialCleaned = 0;
  const backups: string[] = [];
  for (const directory of directories) {
    partialCleaned += await cleanPartialBackups(directory);
    const found = await walkFiles(directory, { match: (name) => name.endsWith(`.zh_CN.wad.client.chosen_bak`) });
    backups.push(...found.sort());
  }

  const planned = backups.length;
  context.progress?.(0, planned);
  const note = partialCleaned ? `（顺带清理 ${partialCleaned} 个未完成的备份文件）` : "";
  if (!planned) {
    return makeResult(MODULE, true, {
      action: "restore",
      planned: 0,
      success: 0,
      failed: 0,
      message: `未发现需要还原的语音备份文件${note}`
    });
  }

  const failures: FailureItem[] = [];
  let success = 0;
  let done = 0;
  for (const bak of backups) {
    if (context.signal?.aborted) break;
    const original = bak.slice(0, -".chosen_bak".length);
    const [ok, reason] = await restoreFileVerbose(original);
    done += 1;
    if (ok) success += 1;
    else failures.push({ file: path.basename(original), reason });
    context.progress?.(done, planned, path.basename(original));
  }

  if (!failures.length) {
    return makeResult(MODULE, true, {
      action: "restore",
      planned,
      success,
      failed: 0,
      message: `已还原 ${success} 个英雄/播报员语音文件${note}`
    });
  }
  const reason = shortReason(failures);
  return makeResult(MODULE, false, {
    action: "restore",
    planned,
    success,
    failed: failures.length,
    reason: `还原失败 ${failures.length} 个：${reason}`,
    message: `还原失败 ${failures.length} 个：${reason}`,
    errors: failures.map((item) => `${item.file}: ${item.reason}`)
  });
}

/** 对局语音相关的资源预检(界面开着"开始切换"按钮前调用)。 */
export async function precheckIngameVoice(locale: string, context: Pick<ModuleContext, "voiceRoot">): Promise<ReturnType<typeof checkModuleResources>> {
  return checkModuleResources(MODULE, locale, { voiceRoot: context.voiceRoot, pluginDir: null });
}

/** 清理某目录里残留的临时文件(诊断用)。 */
export async function cleanupTemps(directory: string): Promise<number> {
  const temps = await walkFiles(directory, { match: (name) => name.endsWith(".chosen_new") || name.endsWith(".part") });
  let removed = 0;
  for (const temp of temps) {
    if (await removeQuietly(temp)) removed += 1;
  }
  return removed;
}

export { pathExists };
