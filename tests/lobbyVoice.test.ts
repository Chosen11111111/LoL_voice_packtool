/** 大厅端全链路: 加载桩 + 插件配置 + 资源挂载 + Rose 配置, 以及还原。 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultConfig } from "../src/core/config.ts";
import type { GamePathResolution } from "../src/core/paths.ts";
import { applyLobbyVoice, getLobbyStatus, restoreLobbyVoice } from "../src/modules/lobbyVoice.ts";
import { applyLobbyLangEn } from "../src/modules/lobbyLang.ts";
import type { SwitchEnv } from "../src/modules/context.ts";
import { cleanupSuite, exists, makePack, makePenguLoader, makeTempDir, readFile, useSuite, writeFile } from "./helpers.ts";

const savedEnv: Record<string, string | undefined> = {};

useSuite("lobby");

describe("大厅端", () => {
before(() => {
  for (const key of ["LOCALAPPDATA", "LEAGUE_VOICE_PENGU"]) savedEnv[key] = process.env[key];
});

after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await cleanupSuite();
});

interface Fixture {
  root: string;
  voiceRoot: string;
  penguDir: string;
  pluginDir: string;
  leagueDir: string;
  finalDir: string;
  env: SwitchEnv;
}

async function buildFixture(prefix: string): Promise<Fixture> {
  const root = await makeTempDir(prefix);
  const voiceRoot = path.join(root, "voice");
  await makePack(voiceRoot, "ja_JP", { champions: ["Ahri"], maps: ["Map11"], lobby: 3 });

  const leagueDir = path.join(root, "install", "LeagueClient");
  const finalDir = path.join(root, "install", "Game", "DATA", "FINAL");
  await writeFile(path.join(leagueDir, "LeagueClient.exe"), "fake-client");
  await writeFile(path.join(leagueDir, "d3d9.dll"), "official-proxy");
  await writeFile(path.join(leagueDir, "Config", "LeagueClientSettings.yaml"), 'locale: "zh_CN"\nother: 1\n');
  await writeFile(path.join(finalDir, "Champions", "Ahri.zh_CN.wad.client"), "CN-Ahri");

  const pengu = await makePenguLoader(root);
  process.env.LOCALAPPDATA = path.join(root, "localappdata");

  const resolution: GamePathResolution = {
    ok: true,
    finalDir,
    gameDir: path.join(root, "install", "Game"),
    leagueDir,
    configuredDir: leagueDir,
    runningDir: "",
    source: "config",
    sourceDetail: "测试",
    mismatch: false,
    message: `游戏文件目录：${finalDir}`
  };

  const env: SwitchEnv = {
    config: defaultConfig(),
    appDir: path.resolve(import.meta.dirname, ".."),
    voiceRoot,
    voiceRootSource: "config",
    penguDir: pengu.penguDir,
    pluginDir: pengu.pluginDir,
    resolution,
    finalDir,
    leagueDir
  };
  process.env.LEAGUE_VOICE_PENGU = pengu.penguDir;
  return { root, voiceRoot, penguDir: pengu.penguDir, pluginDir: pengu.pluginDir, leagueDir, finalDir, env };
}

test("大厅语音: 开启后加载桩/插件配置/资源挂载/加载器配置全部到位", async () => {
  const fixture = await buildFixture("lobby-apply");
  const result = await applyLobbyVoice("ja_JP", fixture.env);
  assert.equal(result.ok, true, result.message);

  // 1. 加载桩覆盖客户端 d3d9.dll, 原文件先备份
  assert.equal(await readFile(path.join(fixture.leagueDir, "d3d9.dll")), "fake-stub-dll");
  assert.equal(await readFile(path.join(fixture.leagueDir, "d3d9.dll.chosen_bak")), "official-proxy");

  // 2. 插件配置与脚本内配置块
  const pluginConfig = JSON.parse(await readFile(path.join(fixture.pluginDir, "config.json")));
  assert.equal(pluginConfig.enabled, true);
  assert.equal(pluginConfig.locale, "ja_JP");
  assert.equal(pluginConfig.cdn_locale, "ja_jp");
  const indexJs = await readFile(path.join(fixture.pluginDir, "index.js"));
  assert.match(indexJs, /let enabled = true;/);
  assert.match(indexJs, /let targetLocale = "ja_JP";/);
  assert.match(indexJs, /let targetCdnLocale = "ja_jp";/);

  // 3. 资源目录联接可直接读到选人语音
  assert.equal(await readFile(path.join(fixture.pluginDir, "voice_assets", "champion-choose-vo", "100.ogg")), "ja_JP-vo-0");

  // 4. 精简加载器目录 + Rose 配置
  const voiceLoader = path.join(path.dirname(fixture.penguDir), "Pengu Voice");
  assert.equal(await exists(path.join(voiceLoader, "core.dll")), true);
  assert.equal(await readFile(path.join(voiceLoader, "plugins", "Chosen-VoiceSync", "index.js")).then((text) => text.length > 0), true);
  const ini = await readFile(path.join(process.env.LOCALAPPDATA!, "Rose", "config.ini"));
  assert.match(ini, /disabled=0/);
  assert.match(ini, new RegExp(`loaderpath=${voiceLoader.replace(/\\/g, "\\\\")}`));
  assert.equal(await exists(path.join(fixture.voiceRoot, "active_locale.json")), true);

  // 5. 状态查询识别为"已开启"
  const status = await getLobbyStatus(fixture.env);
  assert.equal(status.enabled, true);
  assert.equal(status.stub_active, true);
  assert.equal(status.assets_mounted, true);
  assert.equal(status.locale, "ja_JP");
});

test("大厅语音: 还原后加载桩移除、原 d3d9.dll 复位、插件停用", async () => {
  const fixture = await buildFixture("lobby-restore");
  await applyLobbyVoice("ja_JP", fixture.env);
  const restored = await restoreLobbyVoice(fixture.env);
  assert.equal(restored.ok, true, restored.message);

  assert.equal(await readFile(path.join(fixture.leagueDir, "d3d9.dll")), "official-proxy", "必须把客户端原有 d3d9.dll 放回去");
  assert.equal(await exists(path.join(fixture.leagueDir, "d3d9.dll.chosen_bak")), false);
  assert.equal(await exists(path.join(fixture.pluginDir, "voice_assets")), false, "资源联接必须被清理");
  assert.equal(await exists(path.join(fixture.voiceRoot, "active_locale.json")), false);

  const pluginConfig = JSON.parse(await readFile(path.join(fixture.pluginDir, "config.json")));
  assert.equal(pluginConfig.enabled, false);
  const indexJs = await readFile(path.join(fixture.pluginDir, "index.js"));
  assert.match(indexJs, /let enabled = false;/);

  const ini = await readFile(path.join(process.env.LOCALAPPDATA!, "Rose", "config.ini"));
  assert.match(ini, /disabled=1/);

  const status = await getLobbyStatus(fixture.env);
  assert.equal(status.enabled, false);
  assert.equal(status.stub_active, false);
});

test("大厅语音: 资源缺失时失败且不放置加载桩", async () => {
  const fixture = await buildFixture("lobby-missing-assets");
  const emptyVoiceRoot = path.join(fixture.root, "empty-voice");
  await writeFile(path.join(emptyVoiceRoot, "ja_JP", "DATA", "FINAL", "Champions", "Ahri.ja_JP.wad.client"), "jp");

  const result = await applyLobbyVoice("ja_JP", { ...fixture.env, voiceRoot: emptyVoiceRoot });
  assert.equal(result.ok, false);
  assert.equal(result.missing, true);
  assert.equal(await readFile(path.join(fixture.leagueDir, "d3d9.dll")), "official-proxy", "失败时不能动客户端文件");
});

test("大厅界面语言: 切成英文再还原中文", async () => {
  const fixture = await buildFixture("lobby-lang");
  const applied = await applyLobbyLangEn(fixture.env);
  assert.equal(applied.ok, true, applied.message);
  const yaml = await readFile(path.join(fixture.leagueDir, "Config", "LeagueClientSettings.yaml"));
  assert.match(yaml, /locale: "en_US"/);
  assert.match(yaml, /other: 1/, "只改 locale, 不能动其它配置项");

  const { restoreLobbyLangZh } = await import("../src/modules/lobbyLang.ts");
  const restored = await restoreLobbyLangZh(fixture.env);
  assert.equal(restored.ok, true, restored.message);
  assert.match(await readFile(path.join(fixture.leagueDir, "Config", "LeagueClientSettings.yaml")), /locale: "zh_CN"/);
});

test("插件模板缺失时报错而不是静默失败", async () => {
  const fixture = await buildFixture("lobby-no-template");
  await fs.rm(path.join(fixture.pluginDir, "index.js"));
  const result = await applyLobbyVoice("ja_JP", {
    ...fixture.env,
    appDir: path.join(fixture.root, "no-such-app-dir")
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /未找到内置插件模板|未找到大厅语音插件/);
});
});
