/** 语音包根目录: 必须跟着软件目录走(<软件目录>\language), 并且能把老位置的包搬进来。 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { cleanupSuite, makeTempDir, useSuite } from "./helpers.ts";
import { resolveVoiceRoot } from "../src/core/paths.ts";

useSuite("voice-root");
cleanupSuite?.();

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

test("老位置有包: 自动搬进 <软件目录>\\language, 用户不用重下", async () => {
  const appDir = await makeTempDir("appdir");
  const legacy = path.join(appDir, "voice"); // 老版本的软件目录内布局
  await makePack(legacy, "ko_KR");
  delete process.env["LEAGUE_VOICE_ROOT"];

  const resolved = await resolveVoiceRoot({ voiceRoot: "" }, appDir);
  assert.equal(resolved.root, path.join(appDir, "language"));
  assert.equal(await fs.stat(path.join(resolved.root, "ko_KR", "assets")).then(() => true, () => false), true, "包应已搬进来");
  assert.equal(await fs.stat(path.join(legacy, "ko_KR")).then(() => true, () => false), false, "老位置不该再留着");
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
