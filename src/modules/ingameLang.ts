/** 对局端: 游戏内文本语言包切换/还原(目标固定为 Localized/Global.zh_CN.wad.client)。 */
import path from "node:path";
import { backupPath, pathExists, replaceFile, restoreFileVerbose, targetDirState } from "../core/fsx.ts";
import { makeResult, SLOT_MISSING_REASON, type ModuleResult } from "../core/result.ts";
import type { ModuleContext } from "../core/types.ts";
import { isGameRunning } from "../core/win/processes.ts";
import { localeDisplayName } from "../packs/locales.ts";
import { langSources } from "../packs/wad.ts";

const MODULE = "ingame_lang" as const;
const TARGET_NAME = "Global.zh_CN.wad.client";

function targetPath(finalDir: string): string {
  return path.join(finalDir, "Localized", TARGET_NAME);
}

/** 切换游戏内文本语言包。 */
export async function applyIngameLang(locale: string, context: ModuleContext): Promise<ModuleResult> {
  if (await isGameRunning()) {
    return makeResult(MODULE, false, {
      reason: "对局中",
      message: "检测到英雄联盟游戏对局进程正在运行，请退出对局后再切换。"
    });
  }
  const sources = await langSources(locale, context.voiceRoot);
  if (!sources.length) {
    return makeResult(MODULE, false, {
      planned: 0,
      success: 0,
      failed: 0,
      missing: true,
      reason: "资源缺失",
      message:
        `未找到 ${locale} 的游戏内语言包文件 Localized/Global.${locale}.wad.client\n` +
        `期望目录：${path.join(context.voiceRoot, locale, "DATA", "FINAL", "Localized")}`
    });
  }
  if (!context.finalDir) {
    return makeResult(MODULE, false, { reason: "游戏路径未就绪", message: "未能解析游戏文件目录 Game\\DATA\\FINAL。" });
  }

  const destDir = path.join(context.finalDir, "Localized");
  const dst = targetPath(context.finalDir);
  context.progress?.(0, 1);

  const [usable, why] = await targetDirState(destDir);
  if (!usable) {
    return makeResult(MODULE, false, {
      planned: 1,
      success: 0,
      failed: 1,
      reason: `替换失败 1 个：${why}`,
      message: `替换失败 1 个：${why}`,
      errors: [`${TARGET_NAME}: ${why}`]
    });
  }

  if (!(await pathExists(dst)) && !(await pathExists(backupPath(dst)))) {
    return makeResult(MODULE, false, {
      planned: 1,
      success: 0,
      failed: 1,
      reason: `替换失败 1 个：${SLOT_MISSING_REASON}`,
      message: `游戏内没有对应的国服文件：${dst}`,
      errors: [`${TARGET_NAME}: ${SLOT_MISSING_REASON}`]
    });
  }

  const [ok, reason] = await replaceFile(sources[0]!, dst);
  context.progress?.(1, 1, TARGET_NAME);
  if (ok) {
    return makeResult(MODULE, true, {
      planned: 1,
      success: 1,
      failed: 0,
      message: `游戏内语言 1/1 已切换为 ${localeDisplayName(locale)}`
    });
  }
  return makeResult(MODULE, false, {
    planned: 1,
    success: 0,
    failed: 1,
    reason: `替换失败 1 个：${reason}`,
    message: `替换失败 1 个：${reason}`,
    errors: [`${TARGET_NAME}: ${reason}`]
  });
}

/** 还原游戏内文本为国服中文原版。 */
export async function restoreIngameLang(context: ModuleContext): Promise<ModuleResult> {
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
  const dst = targetPath(context.finalDir);
  context.progress?.(0, 1);
  if (!(await pathExists(backupPath(dst)))) {
    context.progress?.(1, 1);
    return makeResult(MODULE, true, {
      action: "restore",
      planned: 0,
      success: 0,
      failed: 0,
      message: "未发现需要还原的语言包备份文件"
    });
  }
  const [ok, reason] = await restoreFileVerbose(dst);
  context.progress?.(1, 1);
  if (ok) {
    return makeResult(MODULE, true, {
      action: "restore",
      planned: 1,
      success: 1,
      failed: 0,
      message: "游戏内文本已恢复为国服默认简中"
    });
  }
  return makeResult(MODULE, false, {
    action: "restore",
    planned: 1,
    success: 0,
    failed: 1,
    reason: `还原失败 1 个：${reason}`,
    message: `还原失败 1 个：${reason}`,
    errors: [`${TARGET_NAME}: ${reason}`]
  });
}
