/**
 * 客户端文字替换核心的测试。
 *
 * 这里**不碰真实客户端**: 用一个极小的假 DOM 把核心跑起来。
 * 目的是保证"改文字"这件事的最坏情况永远只是"没改", 绝不会影响客户端。
 *
 * 范围重申: 本功能只处理英雄联盟**客户端界面**(CEF 页面 DOM), 与局内游戏无关 ——
 * 局内是另一个进程, 注入器只注入客户端的 LeagueClientUx / LeagueClientUxRender。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isCollectable, translate } from "../assets/textpack/plugin/runtime.mjs";

const DICT = { 护甲: "방어력", 攻击速度: "공격 속도", 确定: "OK" };

test("translate: 精确命中字典", () => {
  assert.equal(translate("护甲", DICT, []), "방어력");
});

test("translate: 前后空白原样保留(界面文字常带缩进)", () => {
  assert.equal(translate("\n    护甲  ", DICT, []), "\n    방어력  ");
});

test("translate: 没有对应译文时返回 null(保持原样)", () => {
  assert.equal(translate("这个没有翻译", DICT, []), null);
});

test("translate: 纯英文/数字不动", () => {
  assert.equal(translate("PvP", DICT, []), null);
  assert.equal(translate("12345", DICT, []), null);
  assert.equal(translate("", DICT, []), null);
});

test("translate: 正则规则处理带数字的文字", () => {
  const patterns: [RegExp, string][] = [[/^已选择 (\d+) 个$/, "$1 selected"]];
  assert.equal(translate("已选择 3 个", DICT, patterns), "3 selected");
  assert.equal(translate("已选择 3 个", DICT, []), null);
});

test("isCollectable: 只收含中文、长度适中、还没有译文的文字", () => {
  assert.equal(isCollectable("未翻译的文字", DICT, 40), true);
  assert.equal(isCollectable("护甲", DICT, 40), false, "有译文的不用收集");
  assert.equal(isCollectable("English only", DICT, 40), false);
  assert.equal(isCollectable("很长".repeat(30), DICT, 40), false, "超长的多半是公告/聊天");
});

// ---- 假 DOM: 让核心在 Node 里也能跑 ----

class FakeText {
  nodeType = 3;
  parentElement: any = null;
  isConnected = true;
  nodeValue: string;
  constructor(nodeValue: string) {
    this.nodeValue = nodeValue;
  }
}
class FakeElement {
  nodeType = 1;
  childNodes: any[] = [];
  parentElement: any = null;
  isConnected = true;
  shadowRoot: any = null;
  tagName: string;
  attrs: Record<string, string>;
  constructor(tagName: string, attrs: Record<string, string> = {}) {
    this.tagName = tagName;
    this.attrs = attrs;
  }
  matches(selector: string): boolean {
    const simple = /^\[([\w-]+)='([^']*)'\]$/.exec(selector);
    if (simple) return this.attrs[simple[1]!] === simple[2];
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  append(child: any) {
    child.parentElement = this;
    this.childNodes.push(child);
    return child;
  }
}

function installFakeDom() {
  const body = new FakeElement("BODY");
  const store = new Map<string, string>();
  const globals: any = globalThis as any;
  globals.window = {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v)
    },
    requestAnimationFrame: (cb: () => void) => { cb(); return 1; },
    addEventListener: () => undefined
  };
  globals.document = { body, documentElement: body, createElement: (t: string) => new FakeElement(t) };
  globals.MutationObserver = class { observe() {} disconnect() {} };
  globals.Element = { prototype: { attachShadow() { return new FakeElement("SHADOW"); } } };
  // 注意: Node 24 自带只读的 navigator, 不能直接赋值; 核心逻辑里访问它是包在 try 里的
  return { body, store };
}

test("核心: 改写界面文字, 并且只改客户端页面(假 DOM)", async () => {
  const { body } = installFakeDom();
  const div = body.append(new FakeElement("DIV"));
  const label = div.append(new FakeText("护甲")) as FakeText;
  const input = div.append(new FakeElement("INPUT"));
  const typed = input.append(new FakeText("护甲")) as FakeText;
  const script = div.append(new FakeElement("SCRIPT"));
  const code = script.append(new FakeText("护甲")) as FakeText;

  const { createTextReplacer } = await import("../assets/textpack/plugin/runtime.mjs");
  const replacer = createTextReplacer({ dict: DICT, patterns: [], collect: false });

  assert.equal(label.nodeValue, "방어력", "普通界面文字要翻译");
  assert.equal(typed.nodeValue, "护甲", "输入框里的文字绝不能动");
  assert.equal(code.nodeValue, "护甲", "script 里的内容绝不能动");
  assert.equal(replacer.on, true);
  assert.equal(replacer.stats().replaced, 1);
});

test("核心: 能进 Shadow DOM(客户端大量使用组件)", async () => {
  const { body } = installFakeDom();
  const host = body.append(new FakeElement("DIV"));
  const shadow = new FakeElement("SHADOW");
  host.shadowRoot = shadow;
  const inner = shadow.append(new FakeText("攻击速度")) as FakeText;

  const { createTextReplacer } = await import("../assets/textpack/plugin/runtime.mjs");
  createTextReplacer({ dict: DICT, patterns: [], collect: false });
  assert.equal(inner.nodeValue, "공격 속도", "shadow root 里的文字也要翻译");
});

test("核心: 收集模式记录没翻译到的中文, dump 能导出", async () => {
  const { body } = installFakeDom();
  const div = body.append(new FakeElement("DIV"));
  div.append(new FakeText("没见过的词"));

  const { createTextReplacer } = await import("../assets/textpack/plugin/runtime.mjs");
  const replacer = createTextReplacer({ dict: DICT, patterns: [], collect: true, storageKey: "test_key" });
  assert.equal(replacer.stats().collected, 1);
  assert.deepEqual(replacer.dump(), ["没见过的词"]);
});

test("核心: off() 之后不再改任何文字(给用户的保险开关)", async () => {
  const { body } = installFakeDom();
  const div = body.append(new FakeElement("DIV"));
  const later = div.append(new FakeText("确定")) as FakeText;

  const { createTextReplacer } = await import("../assets/textpack/plugin/runtime.mjs");
  const replacer = createTextReplacer({ dict: DICT, patterns: [], collect: false });
  assert.equal(later.nodeValue, "OK", "开启时正常翻译");
  replacer.off();
  assert.equal(replacer.on, false);
  assert.equal(replacer.off(), "off");
});
