import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { invalidateConfigCache } from "../src/core/config.ts";
import { startUpdateRunTask } from "../src/service.ts";
import { taskManager } from "../src/tasks/manager.ts";
import { makeLeagueInstall, makeTempDir } from "./helpers.ts";

test("同步失败不发布 ready 版本，取消也不更新版本文件", async () => {
  const root = await makeTempDir("failed-update-version");
  const voiceRoot = path.join(root, "voice");
  await fs.mkdir(voiceRoot);
  const original = JSON.stringify({ cdragon_version: "old", status: "ready" });
  await fs.writeFile(path.join(voiceRoot, "version.json"), original);
  const install = await makeLeagueInstall(path.join(root, "install"));
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("content-metadata.json")) res.end(JSON.stringify({ version: "new" }));
    else if (req.url?.endsWith("champion-summary.json")) res.end(JSON.stringify([{ id: 103 }]));
    else res.end("resource");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const previousConfig = process.env.LEAGUE_VOICE_CONFIG;
  const previousRoot = process.env.LEAGUE_VOICE_ROOT;
  const configFile = path.join(root, "config.json");
  await fs.writeFile(configFile, JSON.stringify({ voiceRoot, leaguePath: install.leagueDir, supportedLocales: ["ja_JP"],
    manifestDownloader: path.join(root, "missing-downloader.exe"), cdnBase: `http://127.0.0.1:${port}` }));
  process.env.LEAGUE_VOICE_CONFIG = configFile;
  process.env.LEAGUE_VOICE_ROOT = voiceRoot;
  invalidateConfigCache();
  try {
    const task = startUpdateRunTask();
    const finished = await taskManager.waitFor(task.id);
    assert.equal(finished?.status, "failed");
    assert.equal((finished?.result as any).remote.remoteVersion, "new");
    assert.equal(await fs.readFile(path.join(voiceRoot, "version.json"), "utf8"), original);
    const cancelled = startUpdateRunTask();
    assert.equal(taskManager.cancel(cancelled.id), true);
    assert.equal((await taskManager.waitFor(cancelled.id))?.status, "cancelled");
    assert.equal(await fs.readFile(path.join(voiceRoot, "version.json"), "utf8"), original);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousConfig === undefined) delete process.env.LEAGUE_VOICE_CONFIG; else process.env.LEAGUE_VOICE_CONFIG = previousConfig;
    if (previousRoot === undefined) delete process.env.LEAGUE_VOICE_ROOT; else process.env.LEAGUE_VOICE_ROOT = previousRoot;
    invalidateConfigCache();
  }
});
