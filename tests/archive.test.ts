import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { guessLocaleFromName, importArchive } from "../src/packs/archive.ts";
import { run } from "../src/core/win/shell.ts";
import { makeTempDir, makePack } from "./helpers.ts";

async function archiveFixture(kind: "full" | "localized" | "bare" = "full") {
  const root = await makeTempDir("archive-install");
  const input = path.join(root, "input");
  if (kind === "localized") {
    await fs.mkdir(path.join(input, "DATA", "FINAL", "Localized"), { recursive: true });
    await fs.writeFile(path.join(input, "DATA", "FINAL", "Localized", "Global.ja_JP.wad.client"), "LANG");
  } else if (kind === "bare") {
    await fs.mkdir(path.join(input, "Champions"), { recursive: true });
    await fs.writeFile(path.join(input, "Champions", "Ahri.ja_JP.wad.client"), "VOICE");
  } else { await makePack(input, "ja_JP", { champions: ["Ahri"], maps: [], lobby: 1 }); }
  const archive = path.join(root, "ja_JP.zip");
  const result = await run("tar", ["-a", "-cf", archive, "-C", input, "."]);
  assert.equal(result.ok, true, result.error || result.stderr);
  const voiceRoot = path.join(root, "voice");
  await fs.mkdir(voiceRoot);
  return { root, archive, voiceRoot };
}

test("导入成功后不留下解压临时目录", async () => {
  const f = await archiveFixture();
  const result = await importArchive({ ...f, locale: "ja_JP" });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(await fs.readdir(f.voiceRoot), ["ja_JP"]);
});

test("只含 Localized 的语言包也能通过安装校验", async () => {
  const f = await archiveFixture("localized");
  const result = await importArchive({ ...f, locale: "ja_JP" });
  assert.equal(result.ok, true, result.message);
  assert.equal(await fs.readFile(path.join(result.target, "DATA", "FINAL", "Localized", "Global.ja_JP.wad.client"), "utf8"), "LANG");
});

test("裸 FINAL 结构导入后规范化到 DATA/FINAL", async () => {
  const f = await archiveFixture("bare");
  const result = await importArchive({ ...f, locale: "ja_JP" });
  assert.equal(result.ok, true, result.message);
  assert.equal(await fs.readFile(path.join(result.target, "DATA", "FINAL", "Champions", "Ahri.ja_JP.wad.client"), "utf8"), "VOICE");
});

test("导入预先取消时不安装也不产生临时目录", async () => {
  const f = await archiveFixture();
  const result = await importArchive({ ...f, signal: AbortSignal.abort() });
  assert.equal(result.ok, false);
  assert.match(result.message, /取消/);
  assert.deepEqual(await fs.readdir(f.voiceRoot), []);
});

test("结构识别后取消不会覆盖既有语种包", async () => {
  const f = await archiveFixture();
  await makePack(f.voiceRoot, "ja_JP", { champions: ["Yasuo"] });
  const controller = new AbortController();
  const result = await importArchive({ ...f, locale: "ja_JP", overwrite: true, signal: controller.signal,
    onProgress: (_phase: string, percent: number) => { if (percent === 75) controller.abort(); }
  });
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(path.join(f.voiceRoot, "ja_JP", "DATA", "FINAL", "Champions", "Yasuo.ja_JP.wad.client"), "utf8"), "ja_JP-Yasuo");
  assert.deepEqual(await fs.readdir(f.voiceRoot), ["ja_JP"]);
});

test("拒绝将显式语种当作跨目录路径", async () => {
  const f = await archiveFixture();
  const result = await importArchive({ ...f, locale: "../escaped" });
  assert.equal(result.ok, false);
  assert.match(result.message, /语种|目录/);
  assert.equal(await fs.stat(path.join(f.root, "escaped")).then(() => true).catch(() => false), false);
});

test("旧目录已移走后取消，能恢复原包并清理临时目录", async () => {
  const f = await archiveFixture();
  await makePack(f.voiceRoot, "ja_JP", { champions: ["Yasuo"] });
  const controller = new AbortController();
  const result = await importArchive({ ...f, locale: "ja_JP", overwrite: true, signal: controller.signal,
    onLog: (line) => { if (line.includes("旧目录保留")) controller.abort(); }
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /取消/);
  assert.deepEqual(await fs.readdir(f.voiceRoot), ["ja_JP"]);
  assert.equal(await fs.readFile(path.join(f.voiceRoot, "ja_JP", "DATA", "FINAL", "Champions", "Yasuo.ja_JP.wad.client"), "utf8"), "ja_JP-Yasuo");
});

test("随机上传文件名中的片段不能误识别为语种", () => {
  assert.equal(guessLocaleFromName("pack-CF1234.zip"), null);
  assert.equal(guessLocaleFromName("英雄联盟_ko_KR.zip"), "ko_KR");
});

test("上传临时文件改名后仍按用户原始文件名识别语种", async () => {
  const f = await archiveFixture();
  const opaque = path.join(f.root, "pack-CF1234.zip");
  await fs.rename(f.archive, opaque);
  const result = await importArchive({ ...f, archive: opaque, archiveName: "日语.zip" });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.code, "ja_JP");
  assert.equal(result.locale_source, "archive-name");
});

test("覆盖时日志回调异常也会恢复旧包", async () => {
  const f = await archiveFixture();
  await makePack(f.voiceRoot, "ja_JP", { champions: ["Yasuo"] });
  const result = await importArchive({ ...f, locale: "ja_JP", overwrite: true,
    onLog: (line) => { if (line.includes("旧目录保留")) throw new Error("日志异常"); }
  });
  assert.equal(result.ok, false);
  assert.deepEqual(await fs.readdir(f.voiceRoot), ["ja_JP"]);
  assert.equal(await fs.readFile(path.join(f.voiceRoot, "ja_JP", "DATA", "FINAL", "Champions", "Yasuo.ja_JP.wad.client"), "utf8"), "ja_JP-Yasuo");
});
