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

const CDN = "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-l10n/global";
const CACHE = path.join(import.meta.dirname, "..", ".tmp", "trans");
const OUT = path.join(import.meta.dirname, "..", "assets", "textpack");
/** 客户端界面里可能出现的中文 → 目标语言。zh_cn 是"原文", 其余是"译文"。 */
const SOURCE = "zh_cn";
const TARGETS = ["en_us", "ko_kr", "ja_jp", "zh_tw", "es_es", "fr_fr", "de_de", "pt_br", "ru_ru", "tr_tr", "vi_vn", "th_th", "it_it", "pl_pl", "id_id"];

async function load(locale: string, download: boolean): Promise<Record<string, string> | null> {
  const file = path.join(CACHE, locale + ".json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, string>;
  } catch {
    if (!download) return null;
  }
  const response = await fetch(CDN + "/" + locale + "/trans.json");
  if (!response.ok) return null;
  const text = await response.text();
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(file, text, "utf8");
  return JSON.parse(text) as Record<string, string>;
}

/** 含有中日韩文字的文字, 才算"需要被翻译"的原文。 */
function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(text);
}

const download = process.argv.includes("--download");
const source = await load(SOURCE, download);
if (!source) {
  console.error("读不到原文表 " + SOURCE + ", 先加 --download");
  process.exit(1);
}
console.log("原文表 " + SOURCE + ": " + Object.keys(source).length + " 条");

for (const target of TARGETS) {
  const translated = await load(target, download);
  if (!translated) {
    console.log("  " + target + ": 跳过(没有数据)");
    continue;
  }
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
  const dir = path.join(OUT, target);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "dict.json"), JSON.stringify(dict, null, 0), "utf8");
  console.log("  " + target + ": 共用键 " + shared + " / 需翻译 " + cjk + " / 冲突丢弃 " + collision + " -> " + Object.keys(dict).length + " 条字典");
}
