/** 语音包导入: 目录导入不需要任何解压工具(适配所有系统)。 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { cleanupSuite, makeTempDir, useSuite } from "./helpers.ts";
import { importArchive, findPackLayout } from "../src/packs/archive.ts";

useSuite("pack-import");
cleanupSuite?.();

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(() => true, () => false);
}

test("目录导入: 把已解开的文件夹装进资源目录, 源文件夹保持原样", async () => {
  const voiceRoot = await makeTempDir("voice-root");
  const source = await makeTempDir("pack-src");
  await fs.mkdir(path.join(source, "assets", "champion-choose-vo"), { recursive: true });
  await fs.writeFile(path.join(source, "assets", "champion-choose-vo", "103.ogg"), "OggS");

  const layout = await findPackLayout(source);
  assert.ok(layout, "应识别出选人语音结构");

  const result = await importArchive({ archive: source, voiceRoot, locale: "ko_KR" });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.code, "ko_KR");
  assert.equal(
    await exists(path.join(voiceRoot, "ko_KR", "assets", "champion-choose-vo", "103.ogg")),
    true,
    "文件应装进 <资源目录>\\ko_KR"
  );
  assert.equal(await exists(path.join(source, "assets")), true, "用户自己的源文件夹不能被搬走");
});

test("目录导入: 同名语种已存在时默认拒绝, 提示可以覆盖", async () => {
  const voiceRoot = await makeTempDir("voice-root");
  const source = await makeTempDir("pack-src");
  await fs.mkdir(path.join(source, "assets", "champion-choose-vo"), { recursive: true });
  await fs.writeFile(path.join(source, "assets", "champion-choose-vo", "1.ogg"), "OggS");

  assert.equal((await importArchive({ archive: source, voiceRoot, locale: "ja_JP" })).ok, true);
  const second = await importArchive({ archive: source, voiceRoot, locale: "ja_JP" });
  assert.equal(second.ok, false);
  assert.match(second.message, /已经存在/);
});
