import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import {
  backupPath,
  cleanPartialBackups,
  clearMountPoint,
  createBackup,
  createJunction,
  isJunction,
  removeJunction,
  replaceFile,
  restoreFileVerbose,
  supportsHardlinks,
  walkFiles
} from "../src/core/fsx.ts";
import { cleanupSuite, useSuite, exists, makeTempDir, readFile, writeFile } from "./helpers.ts";

useSuite("fsx");

test.after(async () => {
  await cleanupSuite();
});

test("replaceFile: 目标先备份再替换, 备份保留国服原版", async () => {
  const dir = await makeTempDir("fsx-replace");
  const src = path.join(dir, "src", "Ahri.ja_JP.wad.client");
  const dst = path.join(dir, "game", "Ahri.zh_CN.wad.client");
  await writeFile(src, "JP");
  await writeFile(dst, "CN");

  const [ok, reason] = await replaceFile(src, dst);
  assert.equal(ok, true, reason);
  assert.equal(await readFile(dst), "JP");
  assert.equal(await readFile(backupPath(dst)), "CN", "备份必须是国服原版内容");
  assert.equal(await exists(`${dst}.chosen_new`), false, "临时文件必须清理");
});

test("replaceFile: 还原后内容与备份都回到初始状态", async () => {
  const dir = await makeTempDir("fsx-restore");
  const src = path.join(dir, "src", "Ahri.ja_JP.wad.client");
  const dst = path.join(dir, "game", "Ahri.zh_CN.wad.client");
  await writeFile(src, "JP");
  await writeFile(dst, "CN");
  await replaceFile(src, dst);

  const [ok, reason] = await restoreFileVerbose(dst);
  assert.equal(ok, true, reason);
  assert.equal(await readFile(dst), "CN");
  assert.equal(await exists(backupPath(dst)), false, "还原后备份应被消费掉");
});

test("replaceFile: 资源文件不存在时不动目标文件", async () => {
  const dir = await makeTempDir("fsx-missing-src");
  const dst = path.join(dir, "game", "Ahri.zh_CN.wad.client");
  await writeFile(dst, "CN");

  const [ok, reason] = await replaceFile(path.join(dir, "src", "nope.wad.client"), dst);
  assert.equal(ok, false);
  assert.match(reason, /资源文件不存在/);
  assert.equal(await readFile(dst), "CN");
  assert.equal(await exists(backupPath(dst)), false, "失败的替换绝不能留下备份(否则状态会误判为已开启)");
});

test("replaceFile: 二次替换不覆盖首次备份", async () => {
  const dir = await makeTempDir("fsx-twice");
  const dst = path.join(dir, "game", "Ahri.zh_CN.wad.client");
  await writeFile(path.join(dir, "src", "v1.ja_JP.wad.client"), "JP1");
  await writeFile(path.join(dir, "src", "v2.ja_JP.wad.client"), "JP2");
  await writeFile(dst, "CN");

  await replaceFile(path.join(dir, "src", "v1.ja_JP.wad.client"), dst);
  await replaceFile(path.join(dir, "src", "v2.ja_JP.wad.client"), dst);
  assert.equal(await readFile(dst), "JP2");
  assert.equal(await readFile(backupPath(dst)), "CN", "备份必须始终是最初的国服原版");
});

test("createBackup/cleanPartialBackups: 正式备份只在复制完整后出现", async () => {
  const dir = await makeTempDir("fsx-backup");
  const dst = path.join(dir, "game", "Ahri.zh_CN.wad.client");
  const bak = backupPath(dst);
  await writeFile(dst, "CN");

  const [ok, reason] = await createBackup(dst, bak);
  assert.equal(ok, true, reason);
  assert.equal(await readFile(bak), "CN");

  // 模拟复制中断留下的半份备份: 它必须被清理, 且不会被当成有效备份
  const partial = `${bak}.part`;
  await writeFile(partial, "HALF");
  const removed = await cleanPartialBackups(path.dirname(dst));
  assert.equal(removed, 1);
  assert.equal(await exists(partial), false);
});

test("目录联接: 可创建、可删除, 且拒绝删除真实目录", async () => {
  const dir = await makeTempDir("fsx-junction");
  const target = path.join(dir, "voice-assets");
  const link = path.join(dir, "plugin", "voice_assets");
  await writeFile(path.join(target, "champion-choose-vo", "103.ogg"), "ogg");

  const [created, why] = await createJunction(link, target);
  assert.equal(created, true, why);
  // 注意: Windows junction 在 lstat 里可能被报成普通目录, 所以用 realpath 判定
  assert.equal(await isJunction(link), true);
  assert.equal(await isJunction(target), false, "真实目录不能被误判成联接");
  assert.equal(await readFile(path.join(link, "champion-choose-vo", "103.ogg")), "ogg");

  // 残留的空目录要能被清理(上次中断留下的空壳), 非空目录不能被动
  const emptyDir = path.join(dir, "stale-empty");
  await fs.mkdir(emptyDir, { recursive: true });
  assert.equal(await clearMountPoint(emptyDir), true);
  assert.equal(await exists(emptyDir), false);
  const nonEmpty = path.join(dir, "stale-full");
  await writeFile(path.join(nonEmpty, "keep.txt"), "keep");
  assert.equal(await clearMountPoint(nonEmpty), false);
  assert.equal(await exists(path.join(nonEmpty, "keep.txt")), true);

  const realDir = path.join(dir, "real-dir");
  await writeFile(path.join(realDir, "keep.txt"), "keep");
  assert.equal(await removeJunction(realDir), false, "真实目录绝不能被当成联接删掉");
  assert.equal(await exists(path.join(realDir, "keep.txt")), true);

  assert.equal(await removeJunction(link), true);
  assert.equal(await exists(link), false);
  assert.equal(await exists(target), true, "删除联接不能影响目标目录");
});

test("supportsHardlinks: 项目所在卷可用, 硬链接与源共享内容", async () => {
  const dir = await makeTempDir("fsx-hardlink");
  assert.equal(await supportsHardlinks(dir), true);
  const src = path.join(dir, "a.bin");
  const dst = path.join(dir, "b.bin");
  await writeFile(src, "data");
  await fs.link(src, dst);
  const [srcStat, dstStat] = await Promise.all([fs.stat(src), fs.stat(dst)]);
  assert.equal(srcStat.ino, dstStat.ino);
});

test("walkFiles: 支持递归与 firstOnly 提前返回", async () => {
  const dir = await makeTempDir("fsx-walk");
  await writeFile(path.join(dir, "a.wad.client"), "a");
  await writeFile(path.join(dir, "nested", "b.wad.client"), "b");
  await writeFile(path.join(dir, "nested", "c.txt"), "c");

  const flat = await walkFiles(dir, { match: (name) => name.endsWith(".wad.client") });
  assert.equal(flat.length, 1);
  const deep = await walkFiles(dir, { recursive: true, match: (name) => name.endsWith(".wad.client") });
  assert.equal(deep.length, 2);
  const first = await walkFiles(dir, { recursive: true, match: (name) => name.endsWith(".wad.client"), firstOnly: true });
  assert.equal(first.length, 1);
});
