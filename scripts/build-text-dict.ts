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
/** 同一份数据里, 哪些字段是要替换的界面文字。 */
const GAMEDATA_FIELDS: Record<string, string[]> = {
  "champion-summary.json": ["name"],
  "skins.json": ["name"],
  "items.json": ["name"],
  "summoner-spells.json": ["name"],
  "queues.json": ["name", "shortName", "description", "detailedDescription"]
};
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
    const fields = GAMEDATA_FIELDS[file] ?? ["name"];
    const items: [string, unknown][] = Array.isArray(data)
      ? (data as any[]).map((entry) => [String(entry?.id ?? ""), entry])
      : Object.entries(data as Record<string, unknown>);
    for (const [id, entry] of items) {
      if (!entry || typeof entry !== "object") continue;
      for (const field of fields) {
        const value = (entry as Record<string, unknown>)[field];
        if (typeof value !== "string") continue;
        if (!value || value.length > GAMEDATA_MAX || value.includes("{{")) continue;
        out[id + "|" + field] = value;
      }
    }
  }
  return out;
}

/** 按 id|字段 把两种语言的游戏数据对齐, 得到"中文 -> 译文"。 */
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
  for (const [key, zh] of Object.entries(source)) {
    const other = translated[key];
    if (typeof zh !== "string" || typeof other !== "string") continue;
    shared += 1;
    if (!hasCjk(zh) || zh === other) continue;
    cjk += 1;
    // 同一个中文原文映射到不同译文时, 只能取其一 —— 记录下来, 靠"更长的先替换"缓解
    if (dict[zh] !== undefined && dict[zh] !== other) { collision += 1; continue; }
    dict[zh] = other;
  }
  // 再把游戏数据(英雄名/皮肤名/道具名/技能名/模式名与说明)并进来
  let gameAdded = 0;
  for (const [zh, other] of joinGameData(sourceGame, targetGame)) {
    if (!hasCjk(zh) || dict[zh] !== undefined) continue;
    dict[zh] = other;
    gameAdded += 1;
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
  console.log("  " + target + ": 文字表 " + Object.keys(dict).length + " 条(游戏数据 " + gameAdded + " 条, 人工覆盖 " + manualAdded + " 条)");
}
