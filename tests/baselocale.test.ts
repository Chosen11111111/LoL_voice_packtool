/** 国服 / 外服 适配: 基准语种探测 + 槽位跟随客户端语种。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { detectBaseLocale, detectRegion, wadSuffix } from "../src/packs/baselocale.ts";
import { applyIngameLang, restoreIngameLang } from "../src/modules/ingameLang.ts";
import { applyIngameVoice, restoreIngameVoice } from "../src/modules/ingameVoice.ts";
import { getIngameStatus } from "../src/packs/inventory.ts";
import { backupPath } from "../src/core/fsx.ts";
import { cleanupSuite, exists, makePack, makeTempDir, readFile, useSuite, writeFile } from "./helpers.ts";

useSuite("baselocale");


/** 下面四条来自"外服换语音失效"的真实故障排查 —— 旧测试用的是老路径, 抓不到这个 bug。 */

/** 造一个客户端目录, 把 locale 写进指定位置的设置文件。 */
async function makeClientWithSettings(localeLine: string | null, withLeagueClientLayer = true) {
  const root = await makeTempDir("baselocale-real");
  if (localeLine !== null) {
    const dir = withLeagueClientLayer
      ? path.join(root, "LeagueClient", "Config")
      : path.join(root, "Config");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "LeagueClientSettings.yaml"), localeLine + "\n", "utf8");
  }
  return root;
}

test("基准语种(真机): 认 <客户端>/LeagueClient/Config 下的设置文件", async () => {
  // 实测国服: E:\WeGameApps\英雄联盟\LeagueClient\Config\LeagueClientSettings.yaml
  const root = await makeClientWithSettings("locale: ko_KR");
  const info = await detectBaseLocale({ finalDir: null, leagueDir: root, fallbackLocale: "en_US" });
  assert.equal(info.locale, "ko_KR", "必须按客户端自己的设置走, 不能退到渠道兜底值");
});

test("基准语种(真机): 不带引号的 locale 也要认", async () => {
  const root = await makeClientWithSettings("locale: zh_TW");
  const info = await detectBaseLocale({ finalDir: null, leagueDir: root, fallbackLocale: "en_US" });
  assert.equal(info.locale, "zh_TW");
});

test("基准语种(真机): 带引号的 locale 同样认", async () => {
  const root = await makeClientWithSettings('locale: "en_US"');
  const info = await detectBaseLocale({ finalDir: null, leagueDir: root, fallbackLocale: "zh_CN" });
  assert.equal(info.locale, "en_US");
});

test("基准语种(真机): 什么都读不到时用渠道兜底值, 并把统计写进说明", async () => {
  const root = await makeClientWithSettings(null);
  const info = await detectBaseLocale({ finalDir: null, leagueDir: root, fallbackLocale: "en_US" });
  assert.equal(info.locale, "en_US");
  assert.equal(info.source, "default");
  assert.match(info.detail, /游戏文件统计/);
});

test.after(async () => {
  await cleanupSuite();
});

/** 造一个"国际服"风格的安装: 槽位后缀是客户端实际语种, 而不是 zh_CN。 */
async function makeForeignFinal(dir: string, locale: string): Promise<string> {
  for (const name of ["Ahri", "Yasuo"]) {
    await writeFile(path.join(dir, "Champions", `${name}${wadSuffix(locale)}`), `BASE-${name}`);
  }
  await writeFile(path.join(dir, "Maps", "Shipping", `Map11${wadSuffix(locale)}`), "BASE-Map11");
  await writeFile(path.join(dir, "Localized", `Global${wadSuffix(locale)}`), "BASE-LANG");
  return dir;
}

test("wadSuffix / detectRegion: 后缀与渠道判定", () => {
  assert.equal(wadSuffix("zh_CN"), ".zh_CN.wad.client");
  assert.equal(wadSuffix("en_US"), ".en_US.wad.client");
  assert.equal(detectRegion("E:\\WeGameApps\\英雄联盟\\LeagueClient", "注册表 HKCU\\Software\\Tencent\\LOL"), "cn");
  assert.equal(detectRegion("E:\\Riot Games\\League of Legends", "Riot 产品元数据"), "global");
  assert.equal(detectRegion("D:\\Games\\League of Legends", ""), "global");
});

test("detectBaseLocale: 按游戏文件里的语种后缀判定(而不是写死 zh_CN)", async () => {
  const root = await makeTempDir("baselocale-files");
  const finalDir = path.join(root, "Game", "DATA", "FINAL");
  await makeForeignFinal(finalDir, "en_US");
  // 混入一个别的语种残留, 不能影响判断
  await writeFile(path.join(finalDir, "Champions", "Lux.ko_KR.wad.client"), "x");

  const info = await detectBaseLocale({ finalDir, leagueDir: null });
  assert.equal(info.locale, "en_US");
  assert.equal(info.source, "game-files");
  assert.ok(info.tally.en_US >= 4);
});

test("detectBaseLocale: 游戏文件不可用时退回客户端设置 locale", async () => {
  const root = await makeTempDir("baselocale-settings");
  const leagueDir = path.join(root, "LeagueClient");
  await writeFile(path.join(leagueDir, "LeagueClient.exe"), "x");
  await writeFile(path.join(leagueDir, "Config", "LeagueClientSettings.yaml"), 'locale: "zh_TW"\n');

  const info = await detectBaseLocale({ finalDir: path.join(root, "nope"), leagueDir });
  assert.equal(info.locale, "zh_TW");
  assert.equal(info.source, "client-settings");
});

test("detectBaseLocale: 配置显式指定优先", async () => {
  const root = await makeTempDir("baselocale-config");
  const finalDir = path.join(root, "Game", "DATA", "FINAL");
  await makeForeignFinal(finalDir, "en_US");
  const info = await detectBaseLocale({ finalDir, leagueDir: null, configured: "zh_CN" });
  assert.equal(info.locale, "zh_CN");
  assert.equal(info.source, "config");
});

test("外服: 语音包替换写入客户端语种槽位, 状态与还原都正确", async () => {
  const root = await makeTempDir("baselocale-apply");
  const voiceRoot = path.join(root, "voice");
  const finalDir = path.join(root, "Game", "DATA", "FINAL");
  await makePack(voiceRoot, "ja_JP", { champions: ["Ahri", "Yasuo"], maps: ["Map11"] });
  await makeForeignFinal(finalDir, "en_US");

  const context = { voiceRoot, finalDir, leagueDir: null, baseLocale: "en_US" };
  const applied = await applyIngameVoice("ja_JP", context);
  assert.equal(applied.ok, true, applied.message);
  assert.equal(applied.success, 3);

  // 目标必须是 .en_US 槽位, 且备份里是原版
  assert.equal(await readFile(path.join(finalDir, "Champions", "Ahri.en_US.wad.client")), "ja_JP-Ahri");
  assert.equal(await readFile(backupPath(path.join(finalDir, "Champions", "Ahri.en_US.wad.client"))), "BASE-Ahri");
  assert.equal(await exists(path.join(finalDir, "Champions", "Ahri.zh_CN.wad.client")), false);

  const status = await getIngameStatus({ finalDir, voiceRoot, locale: "ja_JP" });
  assert.equal(status.is_voice_active, true);
  assert.equal(status.voice_backups, 3);

  const restored = await restoreIngameVoice(context);
  assert.equal(restored.ok, true, restored.message);
  assert.equal(await readFile(path.join(finalDir, "Champions", "Ahri.en_US.wad.client")), "BASE-Ahri");
});

test("外服: 文本语言包写入 Global.<客户端语种>", async () => {
  const root = await makeTempDir("baselocale-lang");
  const voiceRoot = path.join(root, "voice");
  const finalDir = path.join(root, "Game", "DATA", "FINAL");
  await makePack(voiceRoot, "ja_JP", { champions: [], maps: [] });
  await makeForeignFinal(finalDir, "zh_TW");

  const context = { voiceRoot, finalDir, leagueDir: null, baseLocale: "zh_TW" };
  const applied = await applyIngameLang("ja_JP", context);
  assert.equal(applied.ok, true, applied.message);
  assert.equal(await readFile(path.join(finalDir, "Localized", "Global.zh_TW.wad.client")), "ja_JP-LANG");

  const restored = await restoreIngameLang(context);
  assert.equal(restored.ok, true, restored.message);
  assert.equal(await readFile(path.join(finalDir, "Localized", "Global.zh_TW.wad.client")), "BASE-LANG");
});

test("跨语种遗留备份也能还原(客户端语种变更过的情况)", async () => {
  const root = await makeTempDir("baselocale-legacy");
  const voiceRoot = path.join(root, "voice");
  const finalDir = path.join(root, "Game", "DATA", "FINAL");
  await makePack(voiceRoot, "ja_JP", { champions: ["Ahri"], maps: [] });
  await makeForeignFinal(finalDir, "en_US");
  await makeFinalDirZh(finalDir);

  // 先用 zh_CN 槽位切一次, 再模拟客户端语种变成 en_US
  await applyIngameVoice("ja_JP", { voiceRoot, finalDir, leagueDir: null, baseLocale: "zh_CN" });
  const restored = await restoreIngameVoice({ voiceRoot, finalDir, leagueDir: null, baseLocale: "en_US" });
  assert.equal(restored.ok, true, restored.message);
  assert.equal(restored.success, 1, "遗留的 zh_CN 备份也要能被还原");
  assert.equal(await readFile(path.join(finalDir, "Champions", "Ahri.zh_CN.wad.client")), "CN-Ahri");
});

async function makeFinalDirZh(dir: string): Promise<void> {
  await writeFile(path.join(dir, "Champions", "Ahri.zh_CN.wad.client"), "CN-Ahri");
}

test("目标槽位缺失时提示里带上客户端基准语种", async () => {
  const root = await makeTempDir("baselocale-missing");
  const voiceRoot = path.join(root, "voice");
  const finalDir = path.join(root, "Game", "DATA", "FINAL");
  await makePack(voiceRoot, "ja_JP", { champions: ["Ahri"], maps: [] });
  await writeFile(path.join(finalDir, "Champions", "Ahri.zh_CN.wad.client"), "CN-Ahri");

  const result = await applyIngameVoice("ja_JP", { voiceRoot, finalDir, leagueDir: null, baseLocale: "en_US" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /目标槽位缺失/);
  assert.match(result.message, /en_US/);
});
