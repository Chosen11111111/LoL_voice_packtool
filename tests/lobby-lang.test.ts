import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { defaultConfig } from "../src/core/config.ts";
import { buildEnv } from "../src/modules/context.ts";
import { applyLobbyLangEn, restoreLobbyLangZh, getLobbyLangState } from "../src/modules/lobbyLang.ts";
import { makeLeagueInstall, makeTempDir, readFile, writeFile } from "./helpers.ts";

async function fixture(text: string, nested = false) {
  const root = await makeTempDir("lobby-lang-foreign");
  const install = await makeLeagueInstall(path.join(root, "install"));
  const file = path.join(install.leagueDir, ...(nested ? ["LeagueClient"] : []), "Config", "LeagueClientSettings.yaml");
  if (nested) {
    const fs = await import("node:fs/promises");
    await fs.rm(path.join(install.leagueDir, "Config", "LeagueClientSettings.yaml"));
  }
  await writeFile(file, text);
  const config = { ...defaultConfig(), leaguePath: install.leagueDir, voiceRoot: path.join(root, "language") };
  const env = await buildEnv({ config, voiceRoot: config.voiceRoot, skipProcess: true, skipAutoDetect: true });
  return { file, env };
}

test("外服大厅语言兼容无引号与嵌套目录，跳过注释项", async () => {
  const f = await fixture('# locale: "en_US"\r\ninstall:\r\n  globals:\r\n    locale: ko_KR # current\r\n', true);
  assert.equal((await getLobbyLangState(f.env)).locale, "ko_KR");
  const result = await applyLobbyLangEn(f.env);
  assert.equal(result.ok, true, result.message);
  assert.match(await readFile(f.file), /# locale: "en_US"\r\n/);
  assert.match(await readFile(f.file), /    locale: "en_US" # current/);
});

test("外服大厅语言还原回首次修改前的语种，保留后来其他设置的变化", async () => {
  const f = await fixture('install:\n  globals:\n    locale: "fr_FR"\n');
  assert.equal((await applyLobbyLangEn(f.env)).ok, true);
  assert.equal((await applyLobbyLangEn(f.env)).ok, true, "重复开启不能覆盖原值");
  await writeFile(f.file, (await readFile(f.file)) + "volume: 25\n");
  const restored = await restoreLobbyLangZh(f.env);
  assert.equal(restored.ok, true, restored.message);
  assert.equal((await getLobbyLangState(f.env)).locale, "fr_FR");
  assert.match(await readFile(f.file), /volume: 25/);
});

test("从未修改过的外服大厅语言，还原时不强行改成中文", async () => {
  const text = 'locale: "zh_TW"\n';
  const f = await fixture(text);
  const restored = await restoreLobbyLangZh(f.env);
  assert.equal(restored.ok, true);
  assert.equal(await readFile(f.file), text);
});
