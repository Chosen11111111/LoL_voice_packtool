/** 实时播报引擎的自测(注入假监听源, 不需要客户端)。 */
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

test("注入假会话源: 悬停英雄会推出一条带播放地址的事件", async () => {
  const voiceRoot = await makeVoiceRoot();
  const engine = new LobbyLiveEngine();
  const received: LobbyLiveEvent[] = [];
  engine.subscribe((event) => received.push(event));

  const session: ChampSelectSession = { localPlayerCellId: 0, gameId: 1, actions: [[pick(0, 103, false)]] };
  const started = await engine.start({
    voiceRoot,
    locale: "ja_JP",
    watcher: (options) => {
      options.onPresence?.("in");
      options.onSession(session, "in");
      return () => undefined;
    }
  });

  assert.equal(started.ok, true);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.kind, "choose");
  assert.equal(received[0]!.championId, 103);
  assert.equal(received[0]!.url, "/api/lobby-audio/choose/103.ogg?locale=ja_JP");

  const state = engine.state();
  assert.equal(state.running, true);
  assert.equal(state.locale, "ja_JP");
  assert.equal(state.played, 1);
  assert.equal(state.presence, "in");
  assert.equal(state.available, 2);
  assert.equal(state.last_event?.championId, 103);

  await engine.stop();
  assert.equal(engine.state().running, false);
});

test("语音包里没有该语种时明确失败, 不启动", async () => {
  const voiceRoot = await makeVoiceRoot();
  const engine = new LobbyLiveEngine();
  const result = await engine.start({ voiceRoot, locale: "ko_KR" });
  assert.equal(result.ok, false);
  assert.match(result.message, /没有 ko_KR 的选人语音/);
  assert.equal(engine.state().running, false);
});

test("禁用动作会推出 ban 事件, 路径指向禁用语音目录", async () => {
  const voiceRoot = await makeVoiceRoot();
  const engine = new LobbyLiveEngine();
  const received: LobbyLiveEvent[] = [];
  engine.subscribe((event) => received.push(event));
  const session: ChampSelectSession = {
    localPlayerCellId: 0,
    gameId: 2,
    actions: [[{ id: 2, actorCellId: 0, championId: 24, type: "ban", completed: true }]]
  };
  await engine.start({
    voiceRoot,
    locale: "ja_JP",
    watcher: (options) => {
      options.onSession(session, "in");
      return () => undefined;
    }
  });
  assert.equal(received.length, 1);
  assert.equal(received[0]!.kind, "ban");
  assert.match(received[0]!.url, /champion|ban/);
  assert.equal(received[0]!.url, "/api/lobby-audio/ban/24.ogg?locale=ja_JP");
  await engine.stop();
});

test.after(async () => {
  await cleanupSuite();
});
