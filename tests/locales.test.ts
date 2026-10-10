import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { cdnLocale, isLocaleCode, isLocaleFolder, localeDisplayName, lobbyAssetsDir, scanLocales } from "../src/packs/locales.ts";
import { cleanupSuite, useSuite, makePack, makeTempDir, writeFile } from "./helpers.ts";

useSuite("locales");

test.after(async () => {
  await cleanupSuite();
});

test("语种代码与显示名", () => {
  assert.equal(isLocaleCode("ja_JP"), true);
  assert.equal(isLocaleCode("en_US"), true);
  assert.equal(isLocaleCode("zh_TW"), true);
  assert.equal(isLocaleCode("assets"), false);
  assert.equal(isLocaleCode("jp"), false);
  assert.equal(localeDisplayName("ja_JP"), "日服 (ja_JP)");
  assert.equal(localeDisplayName("xx_YY"), "xx_YY 语言包");
  assert.equal(cdnLocale("en_US"), "default");
  assert.equal(cdnLocale("ko_KR"), "ko_kr");
});

test("scanLocales: 只认真正含资源的语种目录", async () => {
  const root = await makeTempDir("locales-scan");
  await makePack(root, "ja_JP", { champions: ["Ahri"], maps: ["Map11"], lobby: 2 });
  await makePack(root, "ko_KR", { champions: ["Ahri"], lang: false, lobby: 0 });
  // 噪声目录: 空壳语种、下划线目录、非语种名
  await writeFile(path.join(root, "de_DE", "readme.txt"), "empty");
  await writeFile(path.join(root, "_backup", "x.wad.client"), "x");
  await writeFile(path.join(root, "assets", "note.txt"), "x");
  await writeFile(path.join(root, "scratch_champ_select", "x.ogg"), "x");

  const locales = await scanLocales(root, { withCounts: true });
  assert.deepEqual(locales.map((item) => item.code), ["ja_JP", "ko_KR"]);
  const jp = locales[0]!;
  assert.equal(jp.has_voice, true);
  assert.equal(jp.has_lang, true);
  assert.equal(jp.has_lobby, true);
  assert.equal(jp.voice_files, 1);
  assert.equal(jp.map_files, 1);
  assert.equal(jp.lobby_files, 2);
  const kr = locales[1]!;
  assert.equal(kr.has_lang, false);
  assert.equal(kr.has_lobby, false);
});

test("isLocaleFolder: 空壳目录不算有效语言包", async () => {
  const root = await makeTempDir("locales-empty");
  await writeFile(path.join(root, "ja_JP", "DATA", "FINAL", "Champions", "readme.md"), "x");
  assert.equal(await isLocaleFolder(path.join(root, "ja_JP"), root, "ja_JP"), false);
  await writeFile(path.join(root, "ja_JP", "DATA", "FINAL", "Champions", "Ahri.ja_JP.wad.client"), "x");
  assert.equal(await isLocaleFolder(path.join(root, "ja_JP"), root, "ja_JP"), true);
});

test("lobbyAssetsDir: 兼容 <root>/<locale>/assets 与 <root>/assets/<locale>", async () => {
  const root = await makeTempDir("locales-lobby");
  await writeFile(path.join(root, "ja_JP", "assets", "champion-choose-vo", "1.ogg"), "x");
  assert.equal(await lobbyAssetsDir("ja_JP", root), path.join(root, "ja_JP", "assets"));
  await writeFile(path.join(root, "assets", "ko_KR", "champion-choose-vo", "1.ogg"), "x");
  assert.equal(await lobbyAssetsDir("ko_KR", root), path.join(root, "assets", "ko_KR"));
  assert.equal(await lobbyAssetsDir("en_US", root), null);
});
