/** 实时播报引擎的自测(注入假监听源, 不需要客户端)。**只支持"锁定才播"**。 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { cleanupSuite, makeTempDir, useSuite } from "./helpers.ts";
import { LobbyLiveEngine, type LobbyLiveEvent } from "../src/modules/lobbyLive.ts";
import type { ChampSelectSession } from "../src/modules/champSelect.ts";

useSuite("lobbyLive");

async function makeVoiceRoot(): Promise<string> {
  const root = await makeTempDir("voice-root");
  for (const dir of ["champion-choose-vo", "champion-ban-vo"]) {
    await fs.mkdir(path.join(root, "ja_JP", "assets", dir), { recursive: true });
  }
  await fs.writeFile(path.join(root, "ja_JP", "assets", "champion-choose-vo", "103.ogg"), "OggS-choose-103");
  await fs.writeFile(path.join(root, "ja_JP", "assets", "champion-ban-vo", "24.ogg"), "OggS-ban-24");
  return root;
}

function pick(actorCellId: number, championId: number, completed: boolean) {
  return { id: 1, actorCellId, championId, type: "pick", completed };
}

test("悬停不播, 锁定才播(hover 不产生事件, lock 产生)", async () => {
  const voiceRoot = await makeVoiceRoot();
  const engine = new LobbyLiveEngine();
  const received: LobbyLiveEvent[] = [];
  engine.subscribe((event) => received.push(event));

  const hover: ChampSelectSession = { localPlayerCellId: 0, gameId: 1, actions: [[pick(0, 103, false)]] };
  const locked: ChampSelectSession = { localPlayerCellId: 0, gameId: 1, actions: [[pick(0, 103, true)]] };

  const started = await engine.start({
    voiceRoot,
    locale: "ja_JP",
    watcher: (options) => {
      options.onPresence?.("in");
      options.onSession(hover, "in"); // 第 1 帧: 基线, 不播
      options.onSession(hover, "in"); // 仍然悬停: 不播
      options.onSession(locked, "in"); // 锁定: 播一条
      return () => undefined;
    }
  });

  assert.equal(started.ok, true);
  assert.equal(received.length, 1, "只应有锁定那一条");
  assert.equal(received[0]!.kind, "choose");
  assert.equal(received[0]!.championId, 103);
  assert.equal(received[0]!.phase, "lock");
  assert.equal(received[0]!.url, "/api/lobby-audio/choose/103.ogg?locale=ja_JP");

  const state = engine.state();
  assert.equal(state.running, true);
  assert.equal(state.locale, "ja_JP");
  assert.equal(state.trigger, "lock");
  assert.equal(state.played, 1);
  assert.equal(state.presence, "in");
  assert.equal(state.available, 2);
  assert.equal(state.last_event?.championId, 103);
  assert.equal(state.session_log.length > 0, true);

  await engine.stop();
  assert.equal(engine.state().running, false);
});

test("重复调用 start(同语种)不会重启监听, 也不会重播", async () => {
  const voiceRoot = await makeVoiceRoot();
  const engine = new LobbyLiveEngine();
  const received: LobbyLiveEvent[] = [];
  engine.subscribe((event) => received.push(event));
  const locked: ChampSelectSession = { localPlayerCellId: 0, gameId: 1, actions: [[pick(0, 103, true)]] };

  await engine.start({
    voiceRoot,
    locale: "ja_JP",
    watcher: (options) => {
      options.onPresence?.("in");
      options.onSession({ localPlayerCellId: 0, gameId: 1, actions: [] }, "in"); // 基线
      options.onSession(locked, "in");
      return () => undefined;
    }
  });
  const first = received.length;
  const again = await engine.start({ voiceRoot, locale: "ja_JP" });
  assert.equal(again.ok, true);
  assert.equal(received.length, first, "重复 start 不应产生新事件");
  await engine.stop();
});

test("语音包里没有该语种时明确失败, 不启动", async () => {
  const voiceRoot = await makeVoiceRoot();
  const engine = new LobbyLiveEngine();
  const result = await engine.start({ voiceRoot, locale: "ko_KR" });
  assert.equal(result.ok, false);
  assert.match(result.message, /没有 ko_KR 的选人语音/);
  assert.equal(engine.state().running, false);
});

test("禁用锁定会推出 ban 事件, 路径指向禁用语音目录", async () => {
  const voiceRoot = await makeVoiceRoot();
  const engine = new LobbyLiveEngine();
  const received: LobbyLiveEvent[] = [];
  engine.subscribe((event) => received.push(event));
  const ban: ChampSelectSession = {
    localPlayerCellId: 0,
    gameId: 2,
    actions: [[{ id: 2, actorCellId: 0, championId: 24, type: "ban", completed: true }]]
  };
  await engine.start({
    voiceRoot,
    locale: "ja_JP",
    watcher: (options) => {
      options.onPresence?.("in");
      options.onSession({ localPlayerCellId: 0, gameId: 2, actions: [] }, "in"); // 基线
      options.onSession(ban, "in");
      return () => undefined;
    }
  });
  assert.equal(received.length, 1);
  assert.equal(received[0]!.kind, "ban");
  assert.equal(received[0]!.url, "/api/lobby-audio/ban/24.ogg?locale=ja_JP");
  await engine.stop();
});

test("播放结果上报会记入状态(排障用)", async () => {
  const engine = new LobbyLiveEngine();
  engine.reportPlayback({ ok: false, error: "play_NotAllowedError", detail: "blocked", kind: "choose", championId: 103 });
  const state = engine.state();
  assert.equal(state.playback_failed, 1);
  assert.equal(state.last_playback?.error, "play_NotAllowedError");
  engine.reportPlayback({ ok: true, error: "", detail: "playing", kind: "choose", championId: 103 });
  assert.equal(engine.state().playback_ok, 1);
});

test("客户端未启动: 只提示待机等待, 不假装已生效", async () => {
  const voiceRoot = await makeVoiceRoot();
  const engine = new LobbyLiveEngine();
  const started = await engine.start({
    voiceRoot,
    locale: "ja_JP",
    clientRunning: async () => false,
    watcher: () => () => undefined
  });
  assert.equal(started.ok, true);
  assert.match(started.message, /英雄联盟未启动/);
  assert.match(started.message, /待机等待/);
  await engine.stop();
});

test("客户端在运行时: 正常进入监听状态", async () => {
  const voiceRoot = await makeVoiceRoot();
  const engine = new LobbyLiveEngine();
  const started = await engine.start({
    voiceRoot,
    locale: "ja_JP",
    clientRunning: async () => true,
    watcher: () => () => undefined
  });
  assert.match(started.message, /正在监听选人流程/);
  await engine.stop();
});

test("并发 start 只创建一个轮询器(否则同一场锁定会被播两遍)", async () => {
  const voiceRoot = await makeVoiceRoot();
  const engine = new LobbyLiveEngine();
  let watchers = 0;
  const locked: ChampSelectSession = { localPlayerCellId: 0, gameId: 1, actions: [[pick(0, 103, true)]] };
  const received: LobbyLiveEvent[] = [];
  engine.subscribe((event) => received.push(event));

  const options = {
    voiceRoot,
    locale: "ja_JP",
    clientRunning: async () => true,
    watcher: (watchOptions: Parameters<typeof import("../src/core/win/lcuEvents.ts").watchChampSelect>[0]) => {
      watchers += 1;
      watchOptions.onPresence?.("in");
      watchOptions.onSession({ localPlayerCellId: 0, gameId: 1, actions: [] }, "in"); // 基线
      watchOptions.onSession(locked, "in");
      return () => undefined;
    }
  };

  // 界面会在多处同时调用 start(页面加载/刷新/勾选框变化/模块应用)
  await Promise.all([engine.start(options), engine.start(options), engine.start(options)]);
  assert.equal(watchers, 1, "并发启动只能创建一个轮询器");
  assert.equal(received.length, 1, "同一场锁定只能播一条");
  await engine.stop();
});

test.after(async () => {
  await cleanupSuite();
});
