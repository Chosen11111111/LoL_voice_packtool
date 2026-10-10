import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { langSources, matchLocaleFiles, targetFileName, voiceGroups, wadStem } from "../src/packs/wad.ts";
import { cleanupSuite, useSuite, makePack, makeTempDir, writeFile } from "./helpers.ts";

useSuite("wad");

test.after(async () => {
  await cleanupSuite();
});

test("wadStem / targetFileName: 目标一律写成国服槽位", () => {
  assert.equal(wadStem("Ahri.ja_JP.wad.client"), "Ahri");
  assert.equal(wadStem("Ahri.wad.client"), "Ahri");
  assert.equal(wadStem("Map11.zh_CN.wad.client"), "Map11");
  assert.equal(targetFileName("/x/y/Ahri.ja_JP.wad.client"), "Ahri.zh_CN.wad.client");
});

test("matchLocaleFiles: 只接受本语种与无后缀文件, 其它语种绝不误用", async () => {
  const root = await makeTempDir("wad-match");
  const dir = path.join(root, "champions");
  await writeFile(path.join(dir, "Ahri.ja_JP.wad.client"), "jp");
  await writeFile(path.join(dir, "Yasuo.wad.client"), "plain");
  await writeFile(path.join(dir, "Lux.ko_KR.wad.client"), "kr");
  await writeFile(path.join(dir, "Ashe.zh_CN.wad.client"), "cn");

  const matched = await matchLocaleFiles(dir, "ja_JP");
  assert.deepEqual(
    matched.map((file) => path.basename(file)).sort(),
    ["Ahri.ja_JP.wad.client", "Yasuo.wad.client"]
  );
});

test("matchLocaleFiles: 语种精确匹配优先于无后缀同名文件", async () => {
  const root = await makeTempDir("wad-priority");
  const dir = path.join(root, "champions");
  await writeFile(path.join(dir, "Ahri.wad.client"), "plain");
  await writeFile(path.join(dir, "Ahri.ja_JP.wad.client"), "jp");
  const matched = await matchLocaleFiles(dir, "ja_JP");
  assert.equal(matched.length, 1);
  assert.equal(path.basename(matched[0]!), "Ahri.ja_JP.wad.client");
});

test("matchLocaleFiles: stem 限制确保语言包只认 Global", async () => {
  const root = await makeTempDir("wad-stem");
  const dir = path.join(root, "localized");
  await writeFile(path.join(dir, "Global.ja_JP.wad.client"), "global");
  await writeFile(path.join(dir, "SomethingElse.ja_JP.wad.client"), "other");
  const matched = await matchLocaleFiles(dir, "ja_JP", { stem: "Global" });
  assert.equal(matched.length, 1);
  assert.equal(path.basename(matched[0]!), "Global.ja_JP.wad.client");
});

test("voiceGroups / langSources: 生成正确的替换计划", async () => {
  const root = await makeTempDir("wad-groups");
  await makePack(root, "ja_JP", { champions: ["Ahri"], maps: ["Map11"] });
  const finalDir = path.join(root, "game-final");
  const groups = await voiceGroups("ja_JP", root, finalDir);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.sources.length, 1);
  assert.equal(groups[1]!.sources.length, 1);
  assert.equal(groups[0]!.destDir, path.join(finalDir, "Champions"));
  const langs = await langSources("ja_JP", root);
  assert.equal(langs.length, 1);
});
