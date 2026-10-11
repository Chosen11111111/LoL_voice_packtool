import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { defaultConfig } from "../src/core/config.ts";
import { buildEnv } from "../src/modules/context.ts";
import { applyAll, restoreAll } from "../src/modules/oneclick.ts";
import { applyIngameLang } from "../src/modules/ingameLang.ts";
import { applyIngameVoice } from "../src/modules/ingameVoice.ts";
import { makeLeagueInstall, makePack, makeTempDir, readFile, exists, writeFile } from "./helpers.ts";

async function fixture() {
  const root = await makeTempDir("oneclick-selection");
  const install = await makeLeagueInstall(path.join(root, "install"));
  const voiceRoot = path.join(root, "voice");
  await makePack(voiceRoot, "ja_JP");
  const config = { ...defaultConfig(), leaguePath: install.leagueDir, voiceRoot };
  const env = await buildEnv({ config, voiceRoot, skipProcess: true, skipAutoDetect: true });
  return { ...install, voiceRoot, env };
}

test("多模块还原仅处理指定模块，保留未选中的语音备份", async () => {
  const f = await fixture();
  assert.equal((await applyIngameVoice("ja_JP", f.env)).ok, true);
  assert.equal((await applyIngameLang("ja_JP", f.env)).ok, true);
  const configFile = path.join(f.leagueDir, "Config", "LeagueClientSettings.yaml");
  await writeFile(configFile, 'locale: "en_US"\n');
  const result = await restoreAll(f.env, { modules: ["ingame_lang"], restartClient: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((item) => item.module), ["ingame_lang"]);
  assert.equal(await readFile(path.join(f.finalDir, "Localized", "Global.zh_CN.wad.client")), "CN-LANG");
  assert.equal(await readFile(path.join(f.finalDir, "Champions", "Ahri.zh_CN.wad.client")), "ja_JP-Ahri");
  assert.equal(await exists(path.join(f.finalDir, "Champions", "Ahri.zh_CN.wad.client.chosen_bak")), true);
  assert.equal(await readFile(configFile), 'locale: "en_US"\n');
});

test("显式选择大厅语言模块可正确执行", async () => {
  const f = await fixture();
  const result = await applyAll(f.env, { locale: "ja_JP", modules: ["lobby_lang"], restartClient: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((item) => item.module), ["lobby_lang"]);
  assert.match(await readFile(path.join(f.leagueDir, "Config", "LeagueClientSettings.yaml")), /en_US/);
});

test("切换已取消时不继续修改大厅语言", async () => {
  const f = await fixture();
  const signal = AbortSignal.abort();
  const result = await applyAll(f.env, { locale: "ja_JP", modules: ["ingame_voice"], lobbyLang: "en_US", restartClient: false, signal });
  assert.equal(result.ok, false);
  assert.match(await readFile(path.join(f.leagueDir, "Config", "LeagueClientSettings.yaml")), /zh_CN/);
  assert.equal(await readFile(path.join(f.finalDir, "Champions", "Ahri.zh_CN.wad.client")), "CN-Ahri");
});

test("还原已取消时不修改任何模块", async () => {
  const f = await fixture();
  const configFile = path.join(f.leagueDir, "Config", "LeagueClientSettings.yaml");
  await writeFile(configFile, 'locale: "en_US"\n');
  const result = await restoreAll(f.env, { modules: ["lobby_lang", "ingame_lang"], restartClient: false, signal: AbortSignal.abort() });
  assert.equal(result.ok, false);
  assert.match(await readFile(configFile), /en_US/);
});
