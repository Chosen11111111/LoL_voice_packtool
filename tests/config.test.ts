import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { configPath, invalidateConfigCache, loadConfig, saveConfig } from "../src/core/config.ts";
import { writeFileAtomic } from "../src/core/fsx.ts";
import { makeTempDir } from "./helpers.ts";

async function withConfig(run: (root: string) => Promise<void>): Promise<void> {
  const previous = process.env.LEAGUE_VOICE_CONFIG;
  const root = await makeTempDir("config-concurrency");
  process.env.LEAGUE_VOICE_CONFIG = path.join(root, "config.json");
  invalidateConfigCache();
  try { await run(root); }
  finally {
    if (previous === undefined) delete process.env.LEAGUE_VOICE_CONFIG;
    else process.env.LEAGUE_VOICE_CONFIG = previous;
    invalidateConfigCache();
  }
}

test("原子写并发不会共用临时文件或产生半份内容", async () => {
  const root = await makeTempDir("atomic-concurrency");
  const file = path.join(root, "state.json");
  const payloads = Array.from({ length: 20 }, (_, i) => JSON.stringify({ i, data: String(i).repeat(5000) }));
  const results = await Promise.allSettled(payloads.map((payload) => writeFileAtomic(file, payload)));
  assert.equal(results.filter((r) => r.status === "rejected").length, 0);
  assert.ok(payloads.includes(await fs.readFile(file, "utf8")));
  assert.deepEqual(await fs.readdir(root), ["state.json"]);
});

test("并发保存独立配置字段不会丢更新", async () => withConfig(async () => {
  await Promise.all([saveConfig({ defaultLocale: "ko_KR" }), saveConfig({ autoRestartClient: false })]);
  const config = await loadConfig(true);
  assert.equal(config.defaultLocale, "ko_KR");
  assert.equal(config.autoRestartClient, false);
}));

test("配置缓存随配置文件路径变化，不串用旧配置", async () => withConfig(async (root) => {
  await saveConfig({ defaultLocale: "ko_KR" });
  const other = path.join(root, "other.json");
  await fs.writeFile(other, JSON.stringify({ defaultLocale: "en_US" }));
  process.env.LEAGUE_VOICE_CONFIG = other;
  assert.equal((await loadConfig()).defaultLocale, "en_US");
}));

test("调用者修改返回值不会污染配置缓存", async () => withConfig(async () => {
  const config = await loadConfig();
  config.server.port = 1;
  config.supportedLocales.push("bad");
  const next = await loadConfig();
  assert.equal(next.server.port, 43110);
  assert.ok(!next.supportedLocales.includes("bad"));
}));

test("保存失败后仍能继续保存且缓存保持原值", async () => withConfig(async (root) => {
  await saveConfig({ defaultLocale: "ja_JP" });
  const blocked = path.join(root, "blocked");
  await fs.mkdir(blocked);
  process.env.LEAGUE_VOICE_CONFIG = blocked;
  await assert.rejects(saveConfig({ defaultLocale: "ko_KR" }));
  process.env.LEAGUE_VOICE_CONFIG = path.join(root, "config.json");
  assert.equal((await loadConfig()).defaultLocale, "ja_JP");
  await saveConfig({ defaultLocale: "en_US" });
  assert.equal(JSON.parse(await fs.readFile(configPath(), "utf8")).defaultLocale, "en_US");
}));

test("界面配置分次保存不会覆盖其他选项，重新读取保留空选择与零音量", async () => withConfig(async () => {
  await saveConfig({ ui: { selectedLocale: "ko_KR", modules: ["ingame_voice"], volume: 35, followClient: false, region: "global" } });
  await saveConfig({ ui: { selectedLocale: "", volume: 0 } });
  invalidateConfigCache();
  const config = await loadConfig();
  assert.deepEqual(config.ui, {
    selectedLocale: "",
    modules: ["ingame_voice"],
    volume: 0,
    followClient: false,
    voiceDelayMs: 1000,
    lastApplied: null,
    region: "global"
  });
}));
