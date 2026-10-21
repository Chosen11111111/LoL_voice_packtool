/**
 * 对局字体: 换"游戏内文字"语言时, 一并把局内字体换成该语种的官方字体。
 *
 * 不单独占一个界面选项 —— 用户勾选「局内文字」就等于"文字和字体一起换"。
 * 字体全部取自游戏自带的 UI.wad.client, 不下载、不打包、不增加体积。
 */
import path from "node:path";
import { pathExists } from "../core/fsx.ts";
import { applyFontPatches, planFontPatches, restoreFonts, scanFontFaces } from "../packs/gameFonts.ts";
import { backupPathFor } from "../packs/wadfile.ts";

export const UI_WAD_NAME = "UI.wad.client";

/** 局内字体所在的资源包(游戏目录 DATA\FINAL\UI.wad.client)。 */
export function uiWadPath(finalDir: string): string {
  return path.join(finalDir, UI_WAD_NAME);
}

export interface FontStepResult {
  ok: boolean;
  /** 实际换了几条字体条目。 */
  changed: number;
  message: string;
}

/** 按语种替换局内字体。中文保持不变(官方本来就是中文字体)。 */
export async function applyIngameFont(locale: string, finalDir: string): Promise<FontStepResult> {
  const wad = uiWadPath(finalDir);
  // 完整安装一定有这个包; 没有说明游戏没装全或给了个不完整的目录, 不当成错误
  if (!(await pathExists(wad))) {
    return { ok: true, changed: 0, message: "局内字体保持原版" };
  }
  let faces;
  try {
    faces = await scanFontFaces(wad);
  } catch (error) {
    return { ok: false, changed: 0, message: `读取 ${UI_WAD_NAME} 失败：${String((error as Error).message ?? error)}` };
  }
  const patches = planFontPatches(locale, faces);
  if (!patches.length) {
    return { ok: true, changed: 0, message: "局内字体保持原版" };
  }
  try {
    const result = await applyFontPatches(wad, patches);
    if (!result.ok) return { ok: false, changed: 0, message: result.message };
    return { ok: true, changed: result.patched, message: `局内字体已切换(${result.patched} 项)` };
  } catch (error) {
    return { ok: false, changed: 0, message: `替换局内字体失败：${String((error as Error).message ?? error)}` };
  }
}

/** 还原局内字体(把 UI.wad.client 从备份恢复; 没备份过就什么都不做)。 */
export async function restoreIngameFont(finalDir: string): Promise<FontStepResult> {
  const wad = uiWadPath(finalDir);
  if (!(await pathExists(backupPathFor(wad)))) {
    return { ok: true, changed: 0, message: "局内字体无需还原" };
  }
  const result = await restoreFonts(wad);
  return { ok: result.ok, changed: result.ok ? 1 : 0, message: result.message };
}
