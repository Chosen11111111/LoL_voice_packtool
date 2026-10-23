/**
 * 生成"换字体"的 overlay 资源包, 供 LTK2 装载器挂载进游戏。
 *
 * 为什么要走 overlay 而不是直接改游戏文件:
 *   对局端会校验资源包签名(私钥在 Riot 手里), 磁盘上的包改一个字节就判损坏。
 *   LTK2 的做法是运行时把读取重定向到 overlay 副本, 并把内容摘要映射回原包摘要,
 *   让游戏的校验看到"原版摘要" —— 前提是 **overlay 的文件头(含 256 字节签名)与原包完全一致**。
 *   本脚本打补丁时只动条目表和追加区, 文件头一个字节都不碰, 所以天然满足。
 *
 * 用法:
 *   node scripts/make-font-overlay.ts --mode probe                 # 安全实验: 只换拉丁字体, 中文不动
 *   node scripts/make-font-overlay.ts --mode locale --locale ja_JP # 正式: 字体跟随语言
 *   node scripts/make-font-overlay.ts --out <目录>                  # 指定输出目录
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../src/core/fsx.ts";
import { applyFontPatches, planFontPatches, scanFontFaces, verifyPatchedEntries, type FontFace, type FontPatch } from "../src/packs/gameFonts.ts";
import { readWadEntries } from "../src/packs/wadfile.ts";

const HEADER_SIZE = 272;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const mode = arg("mode") ?? "probe";
const locale = arg("locale") ?? "en_US";
const outRoot = path.resolve(arg("out") ?? path.join(process.cwd(), "overlay"));
const gameDir = path.resolve(arg("game") ?? "E:\\WeGameApps\\英雄联盟");
const uiWad = path.join(gameDir, "Game", "DATA", "FINAL", "UI.wad.client");

/** 安全实验: 三条中文字体保持不动, 只把拉丁正文字体换成另一款官方字体(视觉上明显, 中文不受影响)。 */
function probePlan(faces: FontFace[]): FontPatch[] {
  const spiegel = faces.find((f) => f.full === "Spiegel Regular") ?? faces.find((f) => f.family === "Spiegel" && /Regular/.test(f.full));
  const beaufort = faces.find((f) => f.full === "Beaufort for LOL") ?? faces.find((f) => f.family === "Beaufort for LOL" && !/Ja/.test(f.family));
  if (!spiegel || !beaufort) return [];
  return [{ sourceIndex: beaufort.index, targetIndex: spiegel.index, sourceName: beaufort.full, targetName: spiegel.full }];
}

async function main(): Promise<void> {
  if (!(await pathExists(uiWad))) {
    console.error("找不到 UI.wad.client: " + uiWad);
    process.exit(1);
  }
  const faces = await scanFontFaces(uiWad);
  console.log("原包里的字体条目: " + faces.length + " 个");

  const patches = mode === "probe" ? probePlan(faces) : planFontPatches(locale, faces);
  if (!patches.length) {
    console.error(mode === "probe" ? "实验模式没找到可用的英文字体" : "该语种不需要换字体(中文保持原版)");
    process.exit(2);
  }
  console.log("\n替换计划:");
  for (const p of patches) console.log("  " + p.targetName + "  ←  " + p.sourceName);

  const outFile = path.join(outRoot, "DATA", "FINAL", "UI.wad.client");
  await fs.mkdir(path.dirname(outFile), { recursive: true });

  console.log("\n复制原包 → overlay ...");
  await fs.copyFile(uiWad, outFile);
  const before = await fs.stat(outFile);
  console.log("  已复制 " + (before.size / 1024 / 1024).toFixed(1) + " MB");

  console.log("打字体补丁 ...");
  const result = await applyFontPatches(outFile, patches);
  console.log("  " + result.message);

  // 自检 1: 每条被替换的条目校验值必须正确
  const check = await verifyPatchedEntries(outFile, patches.map((p) => p.targetIndex));
  console.log("  条目校验值: " + (check.ok ? "✔ 全部正确" : "✗ " + check.message));

  // 自检 2: 文件头(含 256 字节签名)必须与原包逐字节一致, 否则装载器会拒绝
  const a = Buffer.alloc(HEADER_SIZE);
  const b = Buffer.alloc(HEADER_SIZE);
  const fa = await fs.open(uiWad, "r");
  const fb = await fs.open(outFile, "r");
  await fa.read(a, 0, HEADER_SIZE, 0);
  await fb.read(b, 0, HEADER_SIZE, 0);
  await fa.close();
  await fb.close();
  const headerSame = a.equals(b);

  // 自检 3: 条目数一致
  const toc = await readWadEntries(outFile);
  const tocOrig = await readWadEntries(uiWad);
  const countSame = toc.entries.length === tocOrig.entries.length;

  console.log("  文件头(含签名)与原包一致: " + (headerSame ? "✔" : "✗ 装载器会拒绝"));
  console.log("  条目数一致: " + (countSame ? "✔ " + toc.entries.length : "✗"));
  const after = await fs.stat(outFile);
  console.log("  产物大小: " + (after.size / 1024 / 1024).toFixed(1) + " MB（原包 " + (before.size / 1024 / 1024).toFixed(1) + " MB）");
  console.log("\noverlay 目录: " + outRoot);
  console.log("用 LTK2 装载: ltk2_host.exe \"" + outRoot + "\" --region cn");
  if (!headerSame || !check.ok || !countSame) process.exit(3);
}

main().catch((error) => {
  console.error("失败: " + String((error as Error).message ?? error));
  process.exit(1);
});
