import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { findGameDir, gameBelongsToLeague, normalizeLeagueDir, pathsEquivalent, resolveGamePaths } from "../src/core/paths.ts";
import { cleanupSuite, useSuite, exists, makeLeagueInstall, makeTempDir, writeFile } from "./helpers.ts";

useSuite("paths");

test.after(async () => {
  await cleanupSuite();
});

test("pathsEquivalent: 大小写与结尾斜杠不影响判定", () => {
  assert.equal(pathsEquivalent("E:\\Games\\LOL\\", "e:\\games\\lol"), true);
  assert.equal(pathsEquivalent("E:\\Games\\LOL", "E:\\Games\\LOL2"), false);
  assert.equal(pathsEquivalent("", ""), false);
});

test("normalizeLeagueDir: 支持根目录/固定子目录/自定义子目录", async () => {
  const root = await makeTempDir("paths-normalize");
  await makeLeagueInstall(root);

  // 传入安装根目录 -> 归一化到 LeagueClient 子目录
  assert.equal(await normalizeLeagueDir(root), path.join(root, "LeagueClient"));
  // 传入 LeagueClient 本身 -> 原样返回
  assert.equal(await normalizeLeagueDir(path.join(root, "LeagueClient")), path.join(root, "LeagueClient"));
  // 自定义客户端目录名(网吧/国际服) -> 扫描一级子目录命中
  const custom = await makeTempDir("paths-custom");
  await writeFile(path.join(custom, "SomeClientName", "LeagueClient.exe"), "x");
  assert.equal(await normalizeLeagueDir(custom), path.join(custom, "SomeClientName"));
  // 无效路径
  assert.equal(await normalizeLeagueDir(path.join(root, "nope")), null);
});

test("findGameDir / gameBelongsToLeague: WeGame 与 Riot 两种布局", async () => {
  const wegame = await makeTempDir("paths-wegame");
  const wegameInstall = await makeLeagueInstall(wegame);
  assert.equal(await findGameDir(wegameInstall.leagueDir), path.join(wegame, "Game"));
  assert.equal(gameBelongsToLeague(path.join(wegame, "Game"), wegameInstall.leagueDir), true);

  // Riot 布局: 根目录直接是客户端目录, 游戏在 <root>/Game
  const riot = await makeTempDir("paths-riot");
  await writeFile(path.join(riot, "LeagueClient.exe"), "x");
  await writeFile(path.join(riot, "Game", "League of Legends.exe"), "x");
  assert.equal(await findGameDir(riot), path.join(riot, "Game"));
  assert.equal(gameBelongsToLeague(path.join(riot, "Game"), riot), true);
});

test("resolveGamePaths: 显式路径 -> 直接解析出 FINAL 目录", async () => {
  const root = await makeTempDir("paths-resolve");
  const install = await makeLeagueInstall(root, { champions: ["Ahri"] });
  const resolution = await resolveGamePaths({ leaguePath: install.leagueDir, skipProcess: true, skipAutoDetect: true });
  assert.equal(resolution.ok, true, resolution.message);
  assert.equal(resolution.finalDir, install.finalDir);
  assert.equal(resolution.gameDir, path.join(root, "Game"));
  assert.equal(resolution.source, "config");
  assert.equal(resolution.mismatch, false);
});

test("resolveGamePaths: 游戏目录指向另一份安装时判定冲突并停止", async () => {
  const root = await makeTempDir("paths-mismatch");
  const install = await makeLeagueInstall(root);
  const other = await makeTempDir("paths-other-install");
  await writeFile(path.join(other, "League of Legends.exe"), "x");

  const resolution = await resolveGamePaths({
    leaguePath: install.leagueDir,
    gamePath: other,
    skipProcess: true,
    skipAutoDetect: true
  });
  assert.equal(resolution.ok, false);
  assert.equal(resolution.mismatch, true);
  assert.match(resolution.message, /不属于同一份安装/);
});

test("resolveGamePaths: 找不到客户端时给出明确指引", async () => {
  const resolution = await resolveGamePaths({ leaguePath: "", skipProcess: true, skipAutoDetect: true });
  assert.equal(resolution.ok, false);
  assert.match(resolution.message, /未能自动定位英雄联盟客户端/);
});
