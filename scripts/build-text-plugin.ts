/**
 * 把「客户端文字替换核心」和官方字典打成一个可直接放进加载器的插件文件。
 *
 * 产物: assets/textpack/<语种>/plugin/index.js
 *   - 自包含(不 import 任何文件, 也不依赖加载器私有 API) —— 加载器只负责执行它;
 *   - 只处理**客户端界面**(英雄联盟客户端的 CEF 页面 DOM), 与局内游戏无关;
 *   - 出处: runtime.mjs 的源码原样内联(去掉 export 关键字), 后面接一行安装调用。
 *
 * 用法: node scripts/build-text-plugin.ts
 */
import fs from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const runtimeFile = path.join(root, "assets", "textpack", "plugin", "runtime.mjs");
const packDir = path.join(root, "assets", "textpack");

const runtime = (await fs.readFile(runtimeFile, "utf8")).replace(/^export /gm, "").trim();
const locales = (await fs.readdir(packDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name !== "plugin")
  .map((entry) => entry.name)
  .sort();

let built = 0;
for (const locale of locales) {
  const dictFile = path.join(packDir, locale, "dict.json");
  let dict: Record<string, string>;
  try {
    dict = JSON.parse(await fs.readFile(dictFile, "utf8")) as Record<string, string>;
  } catch {
    console.log("  " + locale + ": 跳过(没有 dict.json)");
    continue;
  }
  const header = [
    "/* 自动生成, 请勿手改 —— 由 scripts/build-text-plugin.ts 从 runtime.mjs + " + locale + "/dict.json 生成 */",
    "/* 作用: 把英雄联盟**客户端界面**的中文替换成目标语言。只改客户端页面里的文字, */",
    "/*       不涉及任何文件, 也不涉及局内游戏(局内是另一个进程, 本插件碰不到)。 */"
  ].join("\n");
  const body = [
    header,
    "(() => {",
    runtime,
    "  const dict = " + JSON.stringify(dict) + ";",
    "  const patterns = [];",
    "  try {",
    "    window.__tr = createTextReplacer({ dict, patterns, collect: true });",
    "  } catch (error) {",
    "    /* 最坏情况: 什么都没发生, 客户端保持原样 */",
    "  }",
    "})();",
    ""
  ].join("\n");
  const outDir = path.join(packDir, locale, "plugin");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "index.js"), body, "utf8");
  built += 1;
  console.log("  " + locale + ": " + Object.keys(dict).length + " 条 -> plugin/index.js (" + Math.round(Buffer.byteLength(body) / 1024) + " KB)");
}
console.log("共生成 " + built + " 个插件");
