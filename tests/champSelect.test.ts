/** 选人语音事件推导的自测(纯逻辑, 不需要客户端)。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChampSelectTracker, voiceRelativePath, type ChampSelectSession } from "../src/modules/champSelect.ts";

function session(partial: Partial<ChampSelectSession>): ChampSelectSession {
  return { localPlayerCellId: 0, gameId: 1000, actions: [], ...partial };
}

function pickAction(actorCellId: number, championId: number, completed: boolean) {
  return { id: actorCellId * 10, actorCellId, championId, type: "pick", completed };
}

test("悬停到英雄 -> 播选人台词; 换英雄 -> 再播一次", () => {
  const tracker = new ChampSelectTracker();
  const first = tracker.derive(null, session({ actions: [[pickAction(0, 103, false)]] }), { now: 1000 });
  assert.deepEqual(first.map((item) => [item.kind, item.championId, item.phase]), [["choose", 103, "hover"]]);

  const second = tracker.derive(null, session({ actions: [[pickAction(0, 104, false)]] }), { now: 2000 });
  assert.deepEqual(second.map((item) => [item.championId, item.phase]), [[104, "hover"]]);
});

test("同一英雄没有变化时不重复播; 冷却时间内也不重复", () => {
  const tracker = new ChampSelectTracker();
  tracker.derive(null, session({ actions: [[pickAction(0, 103, false)]] }), { now: 1000 });
  const same = tracker.derive(null, session({ actions: [[pickAction(0, 103, false)]] }), { now: 1500 });
  assert.equal(same.length, 0);

  // 换走再换回来: 冷却期内不播
  tracker.derive(null, session({ actions: [[pickAction(0, 104, false)]] }), { now: 2000 });
  const back = tracker.derive(null, session({ actions: [[pickAction(0, 103, false)]] }), { now: 3000 });
  assert.equal(back.length, 0);
  // 冷却过后可以再播
  const later = tracker.derive(null, session({ actions: [[pickAction(0, 105, false)]] }), { now: 20000 });
  assert.equal(later[0]!.championId, 105);
});

test("直接锁定(hover 与 lock 同帧变化)-> lock", () => {
  const tracker = new ChampSelectTracker();
  const events = tracker.derive(null, session({ actions: [[pickAction(0, 103, true)]] }), { now: 1000 });
  assert.deepEqual(events.map((item) => item.phase), ["lock"]);
});

test("禁用动作 -> 播禁用台词", () => {
  const tracker = new ChampSelectTracker();
  const events = tracker.derive(
    null,
    session({ actions: [[{ id: 1, actorCellId: 0, championId: 24, type: "ban", completed: true }]] }),
    { now: 1000 }
  );
  assert.deepEqual(events.map((item) => [item.kind, item.championId]), [["ban", 24]]);
});

test("默认只播自己的: 别人的 pick/ban 不触发", () => {
  const tracker = new ChampSelectTracker();
  const events = tracker.derive(
    null,
    session({
      localPlayerCellId: 0,
      actions: [[pickAction(1, 103, false), { id: 2, actorCellId: 2, championId: 24, type: "ban", completed: true }]]
    }),
    { now: 1000 }
  );
  assert.equal(events.length, 0);

  const withOthers = new ChampSelectTracker().derive(
    null,
    session({
      localPlayerCellId: 0,
      actions: [[pickAction(1, 103, false), { id: 2, actorCellId: 2, championId: 24, type: "ban", completed: true }]]
    }),
    { now: 1000, includeOthers: true }
  );
  assert.deepEqual(withOthers.map((item) => item.kind).sort(), ["ban", "choose"]);
});

test("换局(gameId 变化)会清空历史", () => {
  const tracker = new ChampSelectTracker();
  tracker.derive(null, session({ gameId: 1, actions: [[pickAction(0, 103, false)]] }), { now: 1000 });
  const next = tracker.derive(
    session({ gameId: 1, actions: [[pickAction(0, 103, false)]] }),
    session({ gameId: 2, actions: [[pickAction(0, 103, false)]] }),
    { now: 1500 }
  );
  assert.equal(next.length, 1);
  assert.equal(next[0]!.championId, 103);
});

test("voiceRelativePath: 选人/禁用对应语音包内的两个目录", () => {
  assert.equal(voiceRelativePath("choose", 103), "assets/champion-choose-vo/103.ogg");
  assert.equal(voiceRelativePath("ban", 103), "assets/champion-ban-vo/103.ogg");
});

test("没有本地玩家信息时不产生事件", () => {
  const tracker = new ChampSelectTracker();
  const events = tracker.derive(
    null,
    { actions: [[pickAction(0, 103, false)]] },
    { now: 1000 }
  );
  assert.equal(events.length, 0);
});
