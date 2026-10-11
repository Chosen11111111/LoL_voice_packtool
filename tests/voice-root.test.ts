/** 语音包根目录: 必须跟着软件目录走(<软件目录>\language), 并且能把老位置的包搬进来。 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { cleanupSuite, makeTempDir, useSuite } from "./helpers.ts";
import { resolveVoiceRoot } from "../src/core/paths.ts";

useSuite("voice-root");
cleanupSuite?.();

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(() => true, () => false);
}

async function makePack(root: string, locale: string): Promise<void> {
  const dir = path.join(root, locale, "assets", "champion-choose-vo");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "103.ogg"), "OggS");
}

test("默认根目录 = <软件目录>\\language(不依赖任何写死的绝对路径)", async () => {
  const appDir = await makeTempDir("appdir");
  await makePack(path.join(appDir, "language"), "ja_JP");
  delete process.env["LEAGUE_VOICE_ROOT"];

  const resolved = await resolveVoiceRoot({ voiceRoot: "" }, appDir);
  assert.equal(resolved.root, path.join(appDir, "language"));
  assert.equal(resolved.source, "appdir");
  assert.equal(resolved.hasPacks, true);
});

test("旧位置有包: 同步进 <软件目录>\\language, 旧位置那一份保留", async () => {
  const appDir = await makeTempDir("appdir");
  const legacy = path.join(appDir, "voice"); // 旧版本的软件目录内布局
  await makePack(legacy, "ko_KR");
  delete process.env["LEAGUE_VOICE_ROOT"];

  const resolved = await resolveVoiceRoot({ voiceRoot: "" }, appDir);
  assert.equal(resolved.root, path.join(appDir, "language"));
  assert.equal(await exists(path.join(resolved.root, "ko_KR", "assets", "champion-choose-vo", "103.ogg")), true, "包应同步进来");
  assert.equal(await exists(path.join(legacy, "ko_KR", "assets", "champion-choose-vo", "103.ogg")), true, "旧位置那一份要保留(用户自己的更新器还在用)");
  await fs.rm(legacy, { recursive: true, force: true });
});

test("旧位置更新了文件 -> 启动时增量同步覆盖, 旧位置不受影响", async () => {
  const appDir = await makeTempDir("appdir");
  const legacy = path.join(appDir, "voice");
  await makePack(legacy, "ja_JP");
  delete process.env["LEAGUE_VOICE_ROOT"];

  const first = await resolveVoiceRoot({ voiceRoot: "" }, appDir);
  const targetFile = path.join(first.root, "ja_JP", "assets", "champion-choose-vo", "103.ogg");
  assert.equal(await fs.readFile(targetFile, "utf8"), "OggS");

  // 模拟"用户用自己的更新器换了内容"(更大且更新)
  const sourceFile = path.join(legacy, "ja_JP", "assets", "champion-choose-vo", "103.ogg");
  await fs.writeFile(sourceFile, "OggS-new-content-longer");
  await fs.utimes(sourceFile, new Date(), new Date(Date.now() + 5000));

  await resolveVoiceRoot({ voiceRoot: "" }, appDir);
  assert.equal(await fs.readFile(targetFile, "utf8"), "OggS-new-content-longer", "工具目录应同步成新内容");
  assert.equal(await fs.readFile(sourceFile, "utf8"), "OggS-new-content-longer", "旧位置原样保留");
  await fs.rm(legacy, { recursive: true, force: true });
});

test("显式指定(config / 环境变量)优先", async () => {
  const appDir = await makeTempDir("appdir");
  const custom = await makeTempDir("custom-root");
  await makePack(custom, "en_US");

  const fromConfig = await resolveVoiceRoot({ voiceRoot: custom }, appDir);
  assert.equal(fromConfig.root, custom);
  assert.equal(fromConfig.source, "config");

  process.env["LEAGUE_VOICE_ROOT"] = custom;
  const fromEnv = await resolveVoiceRoot({ voiceRoot: "" }, appDir);
  assert.equal(fromEnv.source, "env");
  delete process.env["LEAGUE_VOICE_ROOT"];
});
