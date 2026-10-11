/** 客户端原版台词开关的自测(纯逻辑 + 注入假 LCU, 不需要客户端)。 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { cleanupSuite, makeTempDir, useSuite } from "./helpers.ts";
import {
  BAN_KEY,
  PICK_KEY,
  computeAlignedVolume,
  deriveSuppressed,
  readVolumes,
  supportsVoiceToggles
} from "../src/modules/clientVoice.ts";

useSuite("clientVoice");

test("deriveSuppressed: 两个键都关掉才算静音", () => {
  assert.equal(deriveSuppressed({ [PICK_KEY]: false, [BAN_KEY]: false }), true);
  assert.equal(deriveSuppressed({ [PICK_KEY]: false, [BAN_KEY]: true }), false);
  assert.equal(deriveSuppressed({ [PICK_KEY]: true, [BAN_KEY]: true }), false);
  assert.equal(deriveSuppressed({}), false, "缺省时客户端默认是开启的");
  assert.equal(deriveSuppressed(null), false);
});

test("supportsVoiceToggles: 设置里出现过这两个键才认为支持", () => {
  assert.equal(supportsVoiceToggles({ [PICK_KEY]: false }), true);
  assert.equal(supportsVoiceToggles({ [BAN_KEY]: true }), true);
  assert.equal(supportsVoiceToggles({ masterVolume: 42 }), false);
  assert.equal(supportsVoiceToggles(null), false);
});

test("键名与客户端 schema 一致(改错名字就会静音失败)", () => {
  assert.equal(PICK_KEY, "pickChampVoEnabled");
  assert.equal(BAN_KEY, "banChampVoEnabled");
});

test.after(async () => {
  await cleanupSuite();
});

test("computeAlignedVolume: 播报音量 = 总音量 × 音效通道(只按总音量会偏大)", () => {
  assert.equal(computeAlignedVolume({ master: 100, sfx: 100, voice: 100 }), 100);
  // 用户实测组合: 19 / 音效 48 -> 约 9%(以前按总音量给 19%, 所以听着比原版大)
  assert.equal(computeAlignedVolume({ master: 19, sfx: 96, voice: 48 }), 9);
  // 优先 voiceVolume(新键), 没有才退回 sfxVolume
  assert.equal(computeAlignedVolume({ master: 50, sfx: 80, voice: 40 }), 20);
  assert.equal(computeAlignedVolume({ master: 50, sfx: 80, voice: null }), 40);
  // 两个通道键都没有时按 100% 处理
  assert.equal(computeAlignedVolume({ master: 50, sfx: null, voice: null }), 50);
  assert.equal(computeAlignedVolume({ master: 0, sfx: 50, voice: 50 }), 5, "下限 5%, 避免静音成 0");
  assert.equal(computeAlignedVolume(null), null);
});

test("readVolumes: 没写过的通道键返回 null(便于判断用哪个通道)", () => {
  assert.deepEqual(readVolumes({ masterVolume: 42 }), { master: 42, sfx: null, voice: null });
  assert.deepEqual(readVolumes({ masterVolume: 85, sfxVolume: 95, voiceVolume: 47.5 }), { master: 85, sfx: 95, voice: 47.5 });
  assert.equal(readVolumes(null), null);
});
