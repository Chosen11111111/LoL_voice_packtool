/** 选人语音事件推导的自测(纯逻辑, 不需要客户端)。**只支持"锁定才播"**。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChampSelectTracker, voiceRelativePath, type ChampSelectSession } from "../src/modules/champSelect.ts";

function session(partial: Partial<ChampSelectSession>): ChampSelectSession {
  return { localPlayerCellId: 0, gameId: 1000, actions: [], ...partial };
}

function pickAction(actorCellId: number, championId: number, completed: boolean) {
  return { id: actorCellId * 10, actorCellId, championId, type: "pick", completed };
}

test("悬停(未锁定)永远不播", () => {
  const tracker = new ChampSelectTracker();
  const hover = tracker.derive(null, session({ actions: [[pickAction(0, 103, false)]] }), { now: 1000 });
  assert.equal(hover.length, 0);

  // 连续划过多个英雄也不播
  const sweep = tracker.derive(
    null,
    session({ actions: [[pickAction(0, 104, false)], [pickAction(0, 157, false)]] }),
    { now: 2000 }
  );
  assert.equal(sweep.length, 0);
});

test("锁定(点确定)才播, phase 是 lock", () => {
  const tracker = new ChampSelectTracker();
  const events = tracker.derive(null, session({ actions: [[pickAction(0, 103, true)]] }), { now: 1000 });
  assert.deepEqual(
    events.map((item) => [item.kind, item.championId, item.phase, item.source]),
    [["choose", 103, "lock", "action"]]
  );
});

test("同一英雄锁定后不重复播", () => {
  const tracker = new ChampSelectTracker();
  tracker.derive(null, session({ actions: [[pickAction(0, 103, true)]] }), { now: 1000 });
  const again = tracker.derive(null, session({ actions: [[pickAction(0, 103, true)]] }), { now: 1500 });
  assert.equal(again.length, 0);
});

test("换英雄再锁定会播新的", () => {
  const tracker = new ChampSelectTracker();
  tracker.derive(null, session({ actions: [[pickAction(0, 103, true)]] }), { now: 1000 });
  const next = tracker.derive(null, session({ actions: [[pickAction(0, 104, true)]] }), { now: 20000 });
  assert.deepEqual(next.map((item) => item.championId), [104]);
});

test("禁用锁定 -> 播禁用台词", () => {
  const tracker = new ChampSelectTracker();
  const events = tracker.derive(
    null,
    session({ actions: [[{ id: 1, actorCellId: 0, championId: 24, type: "ban", completed: true }]] }),
    { now: 1000 }
  );
  assert.deepEqual(events.map((item) => [item.kind, item.championId]), [["ban", 24]]);
});

test("默认只播自己的; includeOthers 才播别人的", () => {
  const shared = {
    localPlayerCellId: 0,
    actions: [[pickAction(1, 103, true), { id: 2, actorCellId: 2, championId: 24, type: "ban", completed: true }]]
  };
  assert.equal(new ChampSelectTracker().derive(null, session(shared), { now: 1000 }).length, 0);

  const withOthers = new ChampSelectTracker().derive(null, session(shared), { now: 1000, includeOthers: true });
  assert.deepEqual(withOthers.map((item) => item.kind).sort(), ["ban", "choose"]);
});

test("换局(gameId 变化)会清空历史, 同英雄可以再播", () => {
  const tracker = new ChampSelectTracker();
  tracker.derive(null, session({ gameId: 1, actions: [[pickAction(0, 103, true)]] }), { now: 1000 });
  const next = tracker.derive(
    session({ gameId: 1, actions: [[pickAction(0, 103, true)]] }),
    session({ gameId: 2, actions: [[pickAction(0, 103, true)]] }),
    { now: 1500 }
  );
  assert.equal(next.length, 1);
  assert.equal(next[0]!.championId, 103);
});

test("baseline: 刚进入选人/刚重启监听时, 已经锁好的英雄不补播", () => {
  const tracker = new ChampSelectTracker();
  const current = session({ actions: [[pickAction(0, 103, true)]] });
  tracker.baseline(current);
  assert.equal(tracker.derive(null, current, { now: 1000 }).length, 0, "基线内的锁定不该重播");

  const locked = tracker.derive(null, session({ actions: [[pickAction(0, 104, true)]] }), { now: 20000 });
  assert.deepEqual(locked.map((item) => item.championId), [104]);
});

test("voiceRelativePath: 选人/禁用对应语音包内的两个目录", () => {
  assert.equal(voiceRelativePath("choose", 103), "assets/champion-choose-vo/103.ogg");
  assert.equal(voiceRelativePath("ban", 103), "assets/champion-ban-vo/103.ogg");
});

test("没有本地玩家信息时不产生事件", () => {
  const tracker = new ChampSelectTracker();
  assert.equal(tracker.derive(null, { actions: [[pickAction(0, 103, true)]] }, { now: 1000 }).length, 0);
});
