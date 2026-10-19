/**
 * 生成客户端文字翻译字典: 官方译文表 -> 插件用的 dict.json
 *
 * 数据来源(CommunityDragon, 与抓语音用的是同一个站点):
 *   /plugins/rcp-fe-lol-l10n/global/<语种>/trans.json
 * 实测 29 个语种, 各 789 个键, 键一一对应 —— 所以按 key 对齐即可, 不需要人工翻译。
 *
 * 用法:
 *   node scripts/build-text-dict.ts                # 只用本地缓存(.tmp/trans)
 *   node scripts/build-text-dict.ts --download     # 缺哪个下哪个
 * 输出:
 *   assets/textpack/<语种>/dict.json  { "中文原文": "译文" }
 */
import fs from "node:fs/promises";
import path from "node:path";

const PLUGINS_ROOT = "https://raw.communitydragon.org/latest/plugins";
const CDN = PLUGINS_ROOT + "/rcp-fe-lol-l10n/global";
const CACHE = path.join(import.meta.dirname, "..", ".tmp", "trans");
const OUT = path.join(import.meta.dirname, "..", "assets", "textpack");
/** 客户端界面里可能出现的中文 → 目标语言。zh_cn 是"原文", 其余是"译文"。 */
const SOURCE = "zh_cn";
const TARGETS = ["en_us", "ja_jp", "ko_kr"];

/** 列出 CommunityDragon 上的全部客户端插件名。 */
async function listPlugins(): Promise<string[]> {
  const file = path.join(CACHE, "plugins.txt");
  try {
    return (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
  } catch {
    /* 继续联网 */
  }
  const response = await fetch(PLUGINS_ROOT + "/");
  const html = await response.text();
  const names = [...html.matchAll(/href="([^"]+)\/"/g)].map((m) => m[1]!);
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(file, names.join("\n"), "utf8");
  return names;
}

/** 取某个插件某个语种的官方文字表(带磁盘缓存)。 */
async function loadPlugin(plugin: string, locale: string, download: boolean): Promise<Record<string, string> | null> {
  const file = path.join(CACHE, plugin + "." + locale + ".json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, string>;
  } catch {
    if (!download) return null;
  }
  try {
    const response = await fetch(PLUGINS_ROOT + "/" + plugin + "/global/" + locale + "/trans.json");
    if (!response.ok) return null;
    const text = await response.text();
    if (!text.startsWith("{")) return null;
    await fs.mkdir(CACHE, { recursive: true });
    await fs.writeFile(file, text, "utf8");
    return JSON.parse(text) as Record<string, string>;
  } catch {
    return null;
  }
}

/** 全部插件合并成一个"键 -> 文字"表; 同一个键在多个插件里出现时, 先到先得。 */
async function loadMerged(locale: string, download: boolean): Promise<Record<string, string>> {
  const plugins = await listPlugins();
  const merged: Record<string, string> = {};
  const queue = [...plugins];
  const worker = async () => {
    while (queue.length) {
      const plugin = queue.shift();
      if (!plugin) return;
      const table = await loadPlugin(plugin, locale, download);
      if (!table) continue;
      for (const [key, value] of Object.entries(table)) {
        if (typeof value === "string" && merged[key] === undefined) merged[key] = value;
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  // 保留最初那份 l10n 表的兜底路径(老缓存仍然有效)
  const legacy = path.join(CACHE, locale + ".json");
  try {
    const table = JSON.parse(await fs.readFile(legacy, "utf8")) as Record<string, string>;
    for (const [key, value] of Object.entries(table)) if (merged[key] === undefined) merged[key] = value;
  } catch { /* 没有就算了 */ }
  return merged;
}

/**
 * 游戏数据的多语言: 英雄名/皮肤名/道具名/召唤师技能/模式名与说明。
 * 英文那一份在 default 目录(en_us 是 404), 其它语言用自己的目录。
 */
const GAMEDATA = PLUGINS_ROOT + "/rcp-be-lol-game-data/global";
const CDN_LOCALE: Record<string, string> = { en_us: "default" };
const GAMEDATA_FILES = ["champion-summary.json", "skins.json", "items.json", "summoner-spells.json", "queues.json"];
/**
 * 把一份数据里所有的字符串叶子摊平, 用"路径"当键。
 *
 * 原来只挑 name 一个字段, 于是英雄的短名("安妮")、皮肤的别名等等全漏了 —— 实测有上万条
 * 界面上会出现的文字因此永远翻不到。现在整棵树都收, 两边靠路径对齐。
 * 数组只收带 id 的元素: 万一两份数据的排序不同, 也不能把它们错配成"安妮 -> Olaf"。
 */
function flattenStrings(node: unknown, prefix: string, out: Record<string, string>, depth: number): void {
  if (depth > 10) return;
  if (typeof node === "string") {
    if (node.length > 0 && node.length <= GAMEDATA_MAX && !node.includes("{{")) out[prefix] = node;
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const id = item && typeof item === "object" ? (item as Record<string, unknown>).id : undefined;
      if (typeof id !== "number" && typeof id !== "string") continue;
      flattenStrings(item, "id" + String(id), out, depth + 1);
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const [field, value] of Object.entries(node as Record<string, unknown>)) {
      flattenStrings(value, prefix + "/" + field, out, depth + 1);
    }
  }
}
/** 太长的多半是带占位符的说明, 不进字典(避免字典虚胖)。 */
const GAMEDATA_MAX = 300;

async function loadGameData(locale: string, download: boolean): Promise<Record<string, string>> {
  const cdn = CDN_LOCALE[locale] ?? locale;
  const out: Record<string, string> = {};
  for (const file of GAMEDATA_FILES) {
    const cache = path.join(CACHE, "gamedata." + cdn + "." + file);
    let raw: string | null = null;
    try {
      raw = await fs.readFile(cache, "utf8");
    } catch {
      if (download) {
        try {
          const response = await fetch(GAMEDATA + "/" + cdn + "/v1/" + file);
          if (response.ok) {
            raw = await response.text();
            await fs.mkdir(CACHE, { recursive: true });
            await fs.writeFile(cache, raw, "utf8");
          }
        } catch { /* 忽略 */ }
      }
    }
    if (!raw) continue;
    let data: unknown;
    try { data = JSON.parse(raw); } catch { continue; }
    flattenStrings(data, file.replace(/\.json$/, ""), out, 0);

    // 英雄表要统一成"名字 / 称号"两个人话键名再配对。
    // 注意: 只有国服那份的字段含义是反的 ——
    //   中: name = 称号("黑暗之女")   description = 名字("安妮")
    //   英: name = 名字("Annie")      description = 称号("the Dark Child")
    // 两边都按同一个规则取, 就会得到"安妮 -> the Dark Child"这种错译(踩过)。
    if (file === "champion-summary.json" && Array.isArray(data)) {
      const sourceSide = locale === SOURCE;
      for (const entry of data as Array<Record<string, unknown>>) {
        const id = entry?.id;
        if (typeof id !== "number") continue;
        // 注意路径前缀: 数组元素摊平时用的是 "id<编号>", 不带文件名
        delete out["id" + id + "/name"];
        delete out["id" + id + "/description"];
        // 国服这两栏谁才是"玩家看到的名字"并不统一(安妮看的是 description, 盲僧看的是 name),
        // 所以两个都收, 且都指向英文的名字 —— 玩家无论在哪儿看到哪种写法都能变成 Lee Sin。
        const displayName = sourceSide ? entry.description : entry.name;
        const displayTitle = sourceSide ? entry.name : entry.name;
        if (typeof displayName === "string" && displayName) out["id" + id + "/displayName"] = displayName;
        if (typeof displayTitle === "string" && displayTitle) out["id" + id + "/displayTitle"] = displayTitle;
      }
    }
  }
  return out;
}

/** 按路径把两种语言的游戏数据对齐, 得到"中文 -> 译文"。 */
function joinGameData(source: Record<string, string>, target: Record<string, string>): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [key, zh] of Object.entries(source)) {
    const other = target[key];
    if (typeof other !== "string" || other === zh) continue;
    pairs.push([zh, other]);
  }
  return pairs;
}

/** 含有中日韩文字的文字, 才算"需要被翻译"的原文。 */
function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(text);
}

/**
 * 带 HTML 标签的文案要拆成文本片段再配对。
 *
 * 客户端渲染 "<h5>勇敢举动</h5><p>你获得一个额外的属性锻造器…</p>" 时, 标签变成了真正的
 * DOM 元素, 我们要替换的是里面的文本节点。而字典里若只存整段(含标签)原文, 永远匹配不上,
 * 这就是"有些文案死活不翻"的主因之一。两边结构一致, 所以按标签拆开后按下标逐一配对。
 * 片段数量对不上就整条放弃(宁可漏翻, 也不能错翻)。
 */
function splitHtmlPairs(zh: string, other: string): Array<[string, string]> {
  if (!zh.includes("<") && !other.includes("<")) return [];
  const runs = (text: string) => text.split(/<[^>]*>/).map((piece) => piece.trim()).filter((piece) => piece.length > 0);
  const left = runs(zh);
  const right = runs(other);
  if (left.length === 0 || right.length === 0) return [];
  const pairs: Array<[string, string]> = [];
  if (left.length !== right.length) {
    // 段数不一致: 国服与目标语言的标签位置不同, 按顺序配到较短的那一边为止。
    // 用户的要求很明确: "宁可配错也别留中文" —— 所以不加任何过滤, 能配就配。
    const n = Math.min(left.length, right.length);
    for (let i = 0; i < n; i += 1) pairs.push([left[i]!, right[i]!]);
    return pairs;
  }
  for (let i = 0; i < left.length; i += 1) pairs.push([left[i]!, right[i]!]);
  return pairs;
}

const download = process.argv.includes("--download");
const source = await loadMerged(SOURCE, download);
if (Object.keys(source).length === 0) {
  console.error("读不到原文表 " + SOURCE + ", 先加 --download");
  process.exit(1);
}
console.log("原文表 " + SOURCE + ": " + Object.keys(source).length + " 条（已合并客户端全部插件）");

const sourceGame = await loadGameData(SOURCE, download);
console.log("游戏数据(英雄/皮肤/道具/技能/模式): " + Object.keys(sourceGame).length + " 个字段");

for (const target of TARGETS) {
  const translated = await loadMerged(target, download);
  if (!translated) {
    console.log("  " + target + ": 跳过(没有数据)");
    continue;
  }
  const targetGame = await loadGameData(target, download);
  const dict: Record<string, string> = {};
  let shared = 0;
  let cjk = 0;
  let collision = 0;
  let split = 0;

  // 游戏数据先来: 英雄名/皮肤名这类以它为准。界面插件里的文字表有时给的是称号, 会和名字
  // 撞车(实测"安妮"被表里的称号译法占了位), 所以让游戏数据结构先占位, 表格再来补剩下的界面文案。
  let gameAdded = 0;
  for (const [zh, other] of joinGameData(sourceGame, targetGame)) {
    if (!hasCjk(zh) || dict[zh] !== undefined) continue;
    dict[zh] = other;
    gameAdded += 1;
    for (const [pieceZh, pieceOther] of splitHtmlPairs(zh, other)) {
      if (!hasCjk(pieceZh) || pieceZh === pieceOther || dict[pieceZh] !== undefined) continue;
      dict[pieceZh] = pieceOther;
      split += 1;
    }
  }

  for (const [key, zh] of Object.entries(source)) {
    const other = translated[key];
    if (typeof zh !== "string" || typeof other !== "string") continue;
    shared += 1;
    if (!hasCjk(zh) || zh === other) continue;
    cjk += 1;
    // 同一个中文原文映射到不同译文时, 只能取其一 —— 记录下来, 靠"更长的先替换"缓解
    if (dict[zh] !== undefined && dict[zh] !== other) { collision += 1; continue; }
    dict[zh] = other;
    // 带标签的文案: 把里面的文字片段也单独收进来
    for (const [pieceZh, pieceOther] of splitHtmlPairs(zh, other)) {
      if (!hasCjk(pieceZh) || pieceZh === pieceOther) continue;
      if (dict[pieceZh] !== undefined && dict[pieceZh] !== pieceOther) continue;
      dict[pieceZh] = pieceOther;
      split += 1;
    }
  }
  // 最后叠一层"人工覆盖表": 官方数据里没有、或国服写法不一致的词条(比如英雄短名、国服专属皮肤名)
  let manualAdded = 0;
  try {
    const manual = JSON.parse(await fs.readFile(path.join(OUT, target, "manual.json"), "utf8")) as Record<string, string>;
    for (const [zh, other] of Object.entries(manual)) {
      if (typeof other !== "string" || !zh || !other || other === zh) continue;
      if (dict[zh] === other) continue;
      dict[zh] = other;
      manualAdded += 1;
    }
  } catch { /* 没有人工表就跳过 */ }

  const dir = path.join(OUT, target);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "dict.json"), JSON.stringify(dict, null, 0), "utf8");
  console.log("  " + target + ": 文字表 " + Object.keys(dict).length + " 条(游戏数据 " + gameAdded + " 条, 拆标签 " + split + " 条, 人工覆盖 " + manualAdded + " 条)");
}
