import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { cleanupSuite, makeTempDir, useSuite, writeFile } from "./helpers.ts";
import { getLogFile, setLogFile } from "../src/core/logger.ts";

useSuite("logger");

after(async () => {
  setLogFile(null);
  await cleanupSuite();
});

test("日志文件: 可写时正常落盘", async () => {
  const root = await makeTempDir("log-ok");
  const file = path.join(root, "app.log");
  setLogFile(file);
  assert.equal(getLogFile(), file);
  setLogFile(null);
  assert.equal(getLogFile(), null);
});

test("日志文件: 打不开时不能抛错, 只降级为控制台", async () => {
  const root = await makeTempDir("log-bad");
  // 父路径是个文件: 目录都建不出来, 必然无法落盘
  const blocker = path.join(root, "blocker");
  await writeFile(blocker, "x");
  setLogFile(path.join(blocker, "app.log"));
  assert.equal(getLogFile(), null, "打不开就不应该记为已落盘");
  setLogFile(null);
});

test("日志文件: 从坏路径切到好路径仍然可用", async () => {
  const root = await makeTempDir("log-switch");
  const blocker = path.join(root, "blocker");
  await writeFile(blocker, "x");
  const good = path.join(root, "ok.log");
  setLogFile(path.join(blocker, "app.log"));
  setLogFile(good);
  assert.equal(getLogFile(), good);
  setLogFile(null);
});
