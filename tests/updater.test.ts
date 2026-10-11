import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fetchFile, mapLimit } from "../src/packs/updater.ts";
import { makeTempDir } from "./helpers.ts";

async function withServer(handler: http.RequestListener, run: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  try { await run(`http://127.0.0.1:${port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("下载超时覆盖响应体，原文件不被半份下载覆盖", async () => {
  const root = await makeTempDir("download-body-timeout");
  const dest = path.join(root, "audio.ogg");
  await fs.writeFile(dest, "original");
  await withServer((_req, res) => {
    res.writeHead(200);
    res.write("partial");
    const timer = setTimeout(() => res.end("end"), 500);
    res.on("close", () => clearTimeout(timer));
  }, async (base) => {
    const begin = Date.now();
    assert.equal(await fetchFile(base, dest, { timeoutMs: 50, retries: 1, skipExisting: false }), false);
    assert.ok(Date.now() - begin < 350, "超时后无需再等待完整响应或最终重试退避");
    assert.equal(await fs.readFile(dest, "utf8"), "original");
    assert.deepEqual(await fs.readdir(root), ["audio.ogg"]);
  });
});

test("取消下载能中断等待响应体并清理临时文件", async () => {
  const root = await makeTempDir("download-abort");
  const controller = new AbortController();
  await withServer((_req, res) => {
    res.write("partial");
    setTimeout(() => controller.abort(), 40);
    const timer = setTimeout(() => res.end("end"), 500);
    res.on("close", () => clearTimeout(timer));
  }, async (base) => {
    const begin = Date.now();
    assert.equal(await fetchFile(base, path.join(root, "audio.ogg"), { signal: controller.signal }), false);
    assert.ok(Date.now() - begin < 350);
    assert.deepEqual(await fs.readdir(root), []);
  });
});

test("下载 404 无需重复请求相同的缺失资源", async () => {
  const root = await makeTempDir("download-404");
  let requests = 0;
  await withServer((_req, res) => { requests++; res.writeHead(404); res.end(); }, async (base) => {
    assert.equal(await fetchFile(base, path.join(root, "missing.ogg"), { retries: 3 }), false);
    assert.equal(requests, 1);
  });
});

test("流式下载保持内容完整且已有非空文件可以跳过", async () => {
  const root = await makeTempDir("download-stream");
  const bytes = Buffer.alloc(2 * 1024 * 1024, 37);
  let requests = 0;
  await withServer((_req, res) => { requests++; res.end(bytes); }, async (base) => {
    const dest = path.join(root, "audio.ogg");
    assert.equal(await fetchFile(base, dest), true);
    assert.ok((await fs.readFile(dest)).equals(bytes));
    assert.equal(await fetchFile(base, dest), true);
    assert.equal(requests, 1);
    assert.deepEqual(await fs.readdir(root), ["audio.ogg"]);
  });
});

test("并发映射的非法并发数退回一个 worker，输出顺序稳定", async () => {
  for (const limit of [NaN, -1, 1.5, Infinity]) {
    const result = await mapLimit([1, 2, 3], limit, async (item) => item * 2);
    assert.deepEqual(result, [2, 4, 6]);
  }
});

test("worker 失败后等待其它在途 worker 结束再退出", async () => {
  let completed = false;
  await assert.rejects(mapLimit([1, 2], 2, async (item) => {
    if (item === 1) { await new Promise((r) => setTimeout(r, 5)); throw new Error("失败"); }
    await new Promise((r) => setTimeout(r, 30)); completed = true;
    return item;
  }), /失败/);
  assert.equal(completed, true);
});
