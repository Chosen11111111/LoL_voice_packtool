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

/** 对局端字体替换开关: 资源包签名无法重算, 保持关闭。 */
const FONT_PATCH_ENABLED = false;

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
  // 实测结论(两次): 把局内字体条目改掉之后, 即使每条的内容校验值(xxh3_64)都算对了,
  // 游戏仍会报 "Installation is corrupt. WadFile mount failed."。
  // 说明对局端除了逐条校验, 还校验我们无法重算的东西(条目表上的 256 字节 RSA 签名 /
  // 头部的数据校验值 —— 私钥在 Riot 手里)。同一个资源包客户端(LCU)不校验, 所以我们
  // 给客户端打的补丁一直正常; 对局端校验更严, 这条路走不通, 功能先关掉。
  if (!FONT_PATCH_ENABLED) {
    return { ok: true, changed: 0, message: "局内字体保持原版" };
  }
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
