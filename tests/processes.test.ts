import { test, mock } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { clearProcessCache, isClientRunning, isGameRunning, processSnapshot } from "../src/core/win/processes.ts";

async function withSpawn(output: string, run: (count: () => number) => Promise<void>): Promise<void> {
  let calls = 0;
  mock.method(childProcess, "spawn", () => {
    calls++;
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setTimeout(() => { child.stdout.end(output); child.emit("close", 0); }, 20);
    return child;
  });
  syncBuiltinESMExports();
  clearProcessCache();
  try { await run(() => calls); }
  finally { mock.restoreAll(); syncBuiltinESMExports(); clearProcessCache(); }
}

test("10 个同时到来的进程快照只启动一次外部探测", async () => withSpawn("[]", async (count) => {
  await Promise.all(Array.from({ length: 10 }, () => processSnapshot()));
  assert.equal(count(), 1);
}));

test("同时检查游戏进程复用正在进行的 tasklist，后续检查仍取新结果", async () => withSpawn("League of Legends.exe 123", async (count) => {
  assert.ok((await Promise.all(Array.from({ length: 10 }, () => isGameRunning()))).every(Boolean));
  assert.equal(count(), 1);
  await isGameRunning();
  assert.equal(count(), 2);
}));

test("强制刷新能合并在途请求，失效后不复用旧请求", async () => withSpawn("[]", async (count) => {
  const first = processSnapshot(true);
  const same = processSnapshot(true);
  assert.equal(count(), 1);
  clearProcessCache();
  const next = processSnapshot();
  await Promise.all([first, same, next]);
  assert.equal(count(), 2);
  await processSnapshot();
  assert.equal(count(), 2);
}));

test("客户端存在性检查一次 tasklist 即可覆盖三种客户端进程", async () => withSpawn('"LeagueClientUxRender.exe","123"', async (count) => {
  assert.equal(await isClientRunning(), true);
  assert.equal(count(), 1);
}));

test("客户端未启动时也只运行一次 tasklist", async () => withSpawn("INFO: No tasks are running", async (count) => {
  assert.equal(await isClientRunning(), false);
  assert.equal(count(), 1);
}));
