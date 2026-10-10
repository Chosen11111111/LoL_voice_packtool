/** 对局端全链路: 替换 -> 状态 -> 还原, 以及"游戏里没有的槽位不许新建"。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { applyIngameLang, restoreIngameLang } from "../src/modules/ingameLang.ts";
import { applyIngameVoice, restoreIngameVoice } from "../src/modules/ingameVoice.ts";
import { backupPath } from "../src/core/fsx.ts";
import { getIngameStatus } from "../src/packs/inventory.ts";
import { cleanupSuite, useSuite, exists, makeFinalDir, makePack, makeTempDir, readFile } from "./helpers.ts";

useSuite("switch");

test.after(async () => {
  await cleanupSuite();
});

test("对局语音: 替换全部槽位并保留国服备份, 还原后完全复原", async () => {
  const root = await makeTempDir("switch-voice");
  const voiceRoot = path.join(root, "voice");
  const finalDir = path.join(root, "game", "DATA", "FINAL");
  await makePack(voiceRoot, "ja_JP", { champions: ["Ahri", "Yasuo"], maps: ["Map11"] });
  await makeFinalDir(finalDir, { champions: ["Ahri", "Yasuo"], maps: ["Map11"] });

  const progresses: number[] = [];
  const applied = await applyIngameVoice("ja_JP", {
    voiceRoot,
    finalDir,
    leagueDir: null,
    progress: (done, total) => {
      if (done === total && total > 0) progresses.push(total);
    }
  });
  assert.equal(applied.ok, true, applied.message);
  assert.equal(applied.success, 3);
  assert.equal(applied.planned, 3);
  assert.deepEqual(progresses, [3]);

  // 目标文件已是日服内容, 备份里保留国服原版
  assert.equal(await readFile(path.join(finalDir, "Champions", "Ahri.zh_CN.wad.client")), "ja_JP-Ahri");
  assert.equal(await readFile(path.join(finalDir, "Maps", "Shipping", "Map11.zh_CN.wad.client")), "ja_JP-Map11");
  assert.equal(await readFile(backupPath(path.join(finalDir, "Champions", "Yasuo.zh_CN.wad.client"))), "CN-Yasuo");

  const status = await getIngameStatus({ finalDir, voiceRoot, locale: "ja_JP" });
  assert.equal(status.is_voice_active, true);
  assert.equal(status.voice_backups, 3);

  const restored = await restoreIngameVoice({ voiceRoot, finalDir, leagueDir: null });
  assert.equal(restored.ok, true, restored.message);
  assert.equal(restored.success, 3);
  assert.equal(await readFile(path.join(finalDir, "Champions", "Ahri.zh_CN.wad.client")), "CN-Ahri");
  assert.equal(await exists(backupPath(path.join(finalDir, "Champions", "Ahri.zh_CN.wad.client"))), false);

  const after = await getIngameStatus({ finalDir, voiceRoot, locale: "ja_JP" });
  assert.equal(after.is_voice_active, false);
});

test("对局语音: 游戏里没有的槽位记为缺失且绝不新建文件", async () => {
  const root = await makeTempDir("switch-slot-missing");
  const voiceRoot = path.join(root, "voice");
  const finalDir = path.join(root, "game", "DATA", "FINAL");
  // 包里多一个游戏里根本没有的英雄
  await makePack(voiceRoot, "ja_JP", { champions: ["Ahri", "Brand"], maps: [] });
  await makeFinalDir(finalDir, { champions: ["Ahri"], maps: [] });

  const result = await applyIngameVoice("ja_JP", { voiceRoot, finalDir, leagueDir: null });
  assert.equal(result.ok, false);
  assert.equal(result.success, 1);
  assert.equal(result.failed, 1);
  assert.match(result.reason, /目标槽位缺失/);
  assert.equal(await exists(path.join(finalDir, "Champions", "Brand.zh_CN.wad.client")), false);
  assert.equal(await readFile(path.join(finalDir, "Champions", "Ahri.zh_CN.wad.client")), "ja_JP-Ahri");
});

test("对局语音: 资源缺失时直接失败, 不做任何替换", async () => {
  const root = await makeTempDir("switch-no-resource");
  const voiceRoot = path.join(root, "voice");
  const finalDir = path.join(root, "game", "DATA", "FINAL");
  // 只有大厅选人语音、没有对局资源 -> 必须失败并说明原因
  await makePack(voiceRoot, "ja_JP", { champions: [], maps: [], lang: false, lobby: 1 });
  await makeFinalDir(finalDir, { champions: ["Ahri"], maps: [] });

  const result = await applyIngameVoice("ja_JP", { voiceRoot, finalDir, leagueDir: null });
  assert.equal(result.ok, false);
  assert.equal(result.missing, true);
  assert.equal(result.reason, "资源缺失");
  assert.match(result.message, /仅有大厅选人语音的包不能用于对局语音/);
  assert.equal(await readFile(path.join(finalDir, "Champions", "Ahri.zh_CN.wad.client")), "CN-Ahri");
});

test("对局语言: 只替换 Global 槽位, 还原到国服简中", async () => {
  const root = await makeTempDir("switch-lang");
  const voiceRoot = path.join(root, "voice");
  const finalDir = path.join(root, "game", "DATA", "FINAL");
  await makePack(voiceRoot, "ja_JP", { champions: [], maps: [] });
  await makeFinalDir(finalDir, { champions: ["Ahri"], maps: [] });

  const applied = await applyIngameLang("ja_JP", { voiceRoot, finalDir, leagueDir: null });
  assert.equal(applied.ok, true, applied.message);
  assert.equal(await readFile(path.join(finalDir, "Localized", "Global.zh_CN.wad.client")), "ja_JP-LANG");
  assert.equal(await readFile(backupPath(path.join(finalDir, "Localized", "Global.zh_CN.wad.client"))), "CN-LANG");

  const restored = await restoreIngameLang({ voiceRoot, finalDir, leagueDir: null });
  assert.equal(restored.ok, true, restored.message);
  assert.equal(await readFile(path.join(finalDir, "Localized", "Global.zh_CN.wad.client")), "CN-LANG");
});

test("跨语种隔离: 包里混入 ko_KR 文件时, 切成 ja_JP 不会用错语种", async () => {
  const root = await makeTempDir("switch-cross-locale");
  const voiceRoot = path.join(root, "voice");
  const finalDir = path.join(root, "game", "DATA", "FINAL");
  await makePack(voiceRoot, "ja_JP", {
    champions: ["Ahri"],
    maps: [],
    lang: false,
    lobby: 0,
    extras: { "DATA/FINAL/Champions/Yasuo.ko_KR.wad.client": "ko_KR-Yasuo" }
  });
  await makeFinalDir(finalDir, { champions: ["Ahri", "Yasuo"], maps: [] });

  const result = await applyIngameVoice("ja_JP", { voiceRoot, finalDir, leagueDir: null });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.success, 1);
  assert.equal(await readFile(path.join(finalDir, "Champions", "Yasuo.zh_CN.wad.client")), "CN-Yasuo", "韩服文件绝不能被当成日服资源写入");
});

test("资源路径未就绪时不panic, 返回结构化失败", async () => {
  const result = await applyIngameVoice("ja_JP", { voiceRoot: "E:\\definitely-not-here", finalDir: null, leagueDir: null });
  assert.equal(result.ok, false);
  assert.equal(result.module, "ingame_voice");
  assert.ok(result.message.length > 0);
});
