/**
 * 状态栏"当前生效语种"必须来自实际开启的记录。
 *
 * 之前的 bug: getIngameStatus 在没有记录时兜底成 "ja_JP", 而调用方传的是配置默认值
 * (默认也是 ja_JP), 于是不管实际切了哪个语种, 状态栏前两格一律显示"日语"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BAK_SUFFIX, getIngameStatus } from "../src/packs/inventory.ts";

/** 造一个"已经切换过"的游戏目录(有备份文件 => 生效中)。 */
async function makeTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lolvoice-locale-"));
  const finalDir = path.join(root, "final");
  const voiceRoot = path.join(root, "language");
  await fs.mkdir(path.join(finalDir, "Champions"), { recursive: true });
  await fs.mkdir(voiceRoot, { recursive: true });
  await fs.writeFile(path.join(finalDir, "Champions", "Aatrox.wad.client" + BAK_SUFFIX), "x");
  await fs.writeFile(path.join(finalDir, "Champions", "Ahri.wad.client" + BAK_SUFFIX), "x");
  return { root, finalDir, voiceRoot };
}

test("状态栏语种: 记的是韩语就显示韩语", async () => {
  const tree = await makeTree();
  try {
    const status = await getIngameStatus({ finalDir: tree.finalDir, voiceRoot: tree.voiceRoot, locale: "ko_KR" });
    assert.equal(status.is_voice_active, true, "有备份文件就该算生效中");
    assert.match(status.voice, /韩服/, "必须显示实际开启的语种");
    assert.doesNotMatch(status.voice, /日服/, "绝不能显示没切过的日语");
    assert.equal(status.active_locale, "ko_KR");
  } finally {
    await fs.rm(tree.root, { recursive: true, force: true });
  }
});

test("状态栏语种: 没有记录时不许凭空显示日语", async () => {
  const tree = await makeTree();
  try {
    const status = await getIngameStatus({ finalDir: tree.finalDir, voiceRoot: tree.voiceRoot });
    assert.equal(status.is_voice_active, true);
    assert.equal(status.active_locale, "", "没有记录就该是空的, 不能猜");
    assert.doesNotMatch(status.voice, /日语/);
    assert.doesNotMatch(status.lang, /日语/);
  } finally {
    await fs.rm(tree.root, { recursive: true, force: true });
  }
});

test("状态栏语种: language 下老工具留下的 active_locale.json 仍然认", async () => {
  const tree = await makeTree();
  try {
    await fs.writeFile(path.join(tree.voiceRoot, "active_locale.json"), JSON.stringify({ locale: "en_US" }));
    const status = await getIngameStatus({ finalDir: tree.finalDir, voiceRoot: tree.voiceRoot });
    assert.equal(status.active_locale, "en_US");
    assert.match(status.voice, /美服/);
  } finally {
    await fs.rm(tree.root, { recursive: true, force: true });
  }
});
