import { test, mock } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runStreaming } from "../src/core/win/shell.ts";

test("已取消的外部任务不启动子进程", async () => {
  let calls = 0;
  mock.method(childProcess, "spawn", () => { calls++; throw new Error("不应启动"); });
  syncBuiltinESMExports();
  try {
    const result = await runStreaming("unused", [], { signal: AbortSignal.abort() });
    assert.equal(result.error, "aborted");
    assert.equal(calls, 0);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});

test("取消子进程后等待真正关闭，再结束任务", async () => {
  let closed = false;
  const controller = new AbortController();
  mock.method(childProcess, "spawn", () => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {
      setTimeout(() => { closed = true; child.emit("close", null); }, 30);
      return true;
    };
    return child;
  });
  syncBuiltinESMExports();
  try {
    const result = runStreaming("unused", [], { signal: controller.signal });
    controller.abort();
    assert.equal((await result).error, "aborted");
    assert.equal(closed, true);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});
