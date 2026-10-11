import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Router, startHttpServer } from "../src/server/http.ts";
import { makeTempDir } from "./helpers.ts";

test("上传超限返回 413，临时文件清理且后续请求正常", async () => {
  const dir = await makeTempDir("upload-limit");
  const router = new Router();
  router.postRaw("/upload", () => ({ ok: true }));
  const running = await startHttpServer({ host: "127.0.0.1", port: 0, token: "", router, uploadDir: dir, maxUploadBytes: 4 });
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/upload`, { method: "POST", body: "too-large" });
    assert.equal(response.status, 413);
    await response.text();
    assert.deepEqual(await fs.readdir(dir), []);
    assert.equal((await fetch(`http://127.0.0.1:${running.port}/missing`)).status, 404);
  } finally { await running.close(); }
});

test("客户端中断上传后不留下半个临时文件", async () => {
  const dir = await makeTempDir("upload-abort");
  const router = new Router();
  router.postRaw("/upload", () => ({ ok: true }));
  const running = await startHttpServer({ host: "127.0.0.1", port: 0, token: "", router, uploadDir: dir });
  try {
    await new Promise<void>((resolve) => {
      const request = http.request({ host: "127.0.0.1", port: running.port, path: "/upload", method: "POST" });
      request.on("error", () => resolve());
      request.write(Buffer.alloc(4096));
      setTimeout(() => request.destroy(), 40);
    });
    for (let i = 0; i < 30 && (await fs.readdir(dir)).length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(await fs.readdir(dir), []);
  } finally { await running.close(); }
});

test("关闭服务立即清空 SSE 客户端，重复关闭也可完成", async () => {
  const router = new Router();
  const running = await startHttpServer({ host: "127.0.0.1", port: 0, token: "", router });
  const response = await fetch(`http://127.0.0.1:${running.port}/api/events`);
  const reader = response.body!.getReader();
  await reader.read();
  assert.equal(router.sseCount, 1);
  try {
    await running.close();
    assert.equal(router.sseCount, 0);
    await running.close();
  } finally { await reader.cancel().catch(() => undefined); await running.close(); }
});

test("静态文件路径不能越过目录边界", async () => {
  const root = await makeTempDir("static-boundary");
  const web = path.join(root, "web");
  await fs.mkdir(web);
  await fs.mkdir(path.join(root, "web-other"));
  await fs.writeFile(path.join(root, "web-other", "private.txt"), "private-data");
  const router = new Router();
  const running = await startHttpServer({ host: "127.0.0.1", port: 0, token: "", router, staticDir: web });
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/..%5cweb-other%5cprivate.txt`);
    assert.equal(response.status, 404);
    assert.ok(!(await response.text()).includes("private-data"));
  } finally { await running.close(); }
});

test("编码的静态文件名可正常读取", async () => {
  const root = await makeTempDir("static-encoded");
  await fs.writeFile(path.join(root, "资源 文件.txt"), "encoded-ok");
  const running = await startHttpServer({ host: "127.0.0.1", port: 0, token: "", router: new Router(), staticDir: root });
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/${encodeURIComponent("资源 文件.txt")}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "encoded-ok");
  } finally { await running.close(); }
});
