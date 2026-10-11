import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskManager } from "../src/tasks/manager.ts";

test("任务的业务失败必须标为 failed 并保留结果", async () => {
  const manager = new TaskManager();
  const { task } = manager.start("apply", "缺资源", async () => ({ ok: false, message: "资源缺失" }));
  const result = await manager.waitFor(task.id);
  assert.equal(result?.status, "failed");
  assert.equal(result?.error, "资源缺失");
  assert.deepEqual(result?.result, { ok: false, message: "资源缺失" });
});

test("切换期间不允许导入或更新资源", async () => {
  const manager = new TaskManager();
  let finish!: () => void;
  const { task } = manager.start("apply", "切换", () => new Promise<void>((resolve) => { finish = resolve; }));
  try {
    assert.throws(() => manager.start("pack_import", "导入", async () => true), /已有任务/);
    assert.throws(() => manager.start("update_run", "更新", async () => true), /已有任务/);
  } finally {
    finish();
    await manager.waitFor(task.id);
  }
});

test("等待任务结束由完成事件唤醒", async () => {
  const manager = new TaskManager();
  let finish!: () => void;
  const { task } = manager.start("update_check", "检查", () => new Promise<void>((resolve) => { finish = resolve; }));
  const waiting = manager.waitFor(task.id);
  finish();
  const early = await Promise.race([waiting, new Promise<null>((resolve) => setTimeout(() => resolve(null), 60))]);
  assert.equal(early?.status, "succeeded");
  await waiting;
});

test("任务留存有上限，正在运行的任务不会被淘汰", async () => {
  const manager = new TaskManager();
  let finish!: () => void;
  const active = manager.start("update_check", "运行中", () => new Promise<void>((resolve) => { finish = resolve; }));
  try {
    for (let i = 0; i < 110; i++) {
      const { task } = manager.start("update_check", String(i), async () => ({ ok: true }));
      await manager.waitFor(task.id);
    }
    assert.ok(manager.list().length <= 101);
    assert.equal(manager.get(active.task.id)?.status, "running");
  } finally {
    finish();
    await manager.waitFor(active.task.id);
  }
});

test("取消后释放互斥组，结果为 cancelled", async () => {
  const manager = new TaskManager();
  const { task } = manager.start("apply", "取消", async (handle) => {
    await new Promise<void>((resolve) => handle.signal.addEventListener("abort", () => resolve(), { once: true }));
    return { ok: false, message: "已取消" };
  });
  assert.equal(manager.cancel(task.id), true);
  assert.equal((await manager.waitFor(task.id))?.status, "cancelled");
  assert.deepEqual(manager.busyGroups(), {});
  assert.equal(manager.cancel(task.id), false);
});
