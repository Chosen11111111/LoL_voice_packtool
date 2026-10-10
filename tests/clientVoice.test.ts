/** 客户端原版台词开关的自测(纯逻辑 + 注入假 LCU, 不需要客户端)。 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { cleanupSuite, makeTempDir, useSuite } from "./helpers.ts";
import { BAN_KEY, PICK_KEY, deriveSuppressed, supportsVoiceToggles } from "../src/modules/clientVoice.ts";

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
