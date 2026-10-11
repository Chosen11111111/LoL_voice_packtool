import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

// 执行实际 app.js，通过界面事件检验配置保存和全新窗口恢复。
const source = await fs.readFile(new URL("../web/app.js", import.meta.url), "utf8");
class Element {
  value = ""; checked = true; disabled = false; textContent = ""; title = "";
  dataset: Record<string, string> = {}; style = {}; children: Element[] = [];
  handlers: Record<string, Function> = {}; onclick?: Function;
  classList = { add() {}, remove() {}, toggle() { return false; } };
  set innerHTML(_: string) { this.children = []; }
  appendChild(child: Element) { this.children.push(child); }
  addEventListener(name: string, fn: Function) { this.handlers[name] = fn; }
  setAttribute() {} contains() { return false; }
}
async function openWindow(config: any, legacy: Record<string, string> = {}, failSave = false) {
  const elements = new Map<string, Element>();
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const requests: { url: string; options: any }[] = [];
  const windowHandlers: Record<string, Function> = {};
  const window = { addEventListener(name: string, fn: Function) { windowHandlers[name] = fn; } };
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element(), addEventListener() {}, activeElement: null },
    window, localStorage: { getItem: (k: string) => legacy[k] ?? null, setItem() {} },
    Audio: class { volume = 1; pause() {} addEventListener() {} }, EventSource: class { addEventListener() {} },
    Date, Math, Number, String, Object, JSON, Promise, setTimeout, clearTimeout, console,
    // 浏览器里有 setInterval(界面用它做"兜底轮询"), 测试沙箱里给个不真的调度时间的替身
    setInterval: () => 0, clearInterval: () => {},
    fetch: async (url: string, options: any = {}) => {
      requests.push({ url, options });
      let payload: any = { ok: true };
      if (url === "/api/config") {
        if (options.method === "PUT") {
          if (failSave) return { ok: false, status: 500, json: async () => ({ error: "write_failed", message: "磁盘写入失败" }) };
          const patch = JSON.parse(options.body);
          Object.assign(config, { ...patch, ui: { ...config.ui, ...patch.ui } });
        }
        payload = { ok: true, config: structuredClone(config), path: "test/config.json" };
      } else if (url === "/api/state") payload.state = { app: { version: "test" }, paths: {}, busy: {}, ingame: {}, lobby: {} };
      else if (url.startsWith("/api/locales")) payload.locales = [{ code: "ja_JP", name: "日语" }, { code: "ko_KR", name: "韩语" }];
      else if (url === "/api/client-voice") payload = { ok: true, supported: true, auto: true, aligned_volume: 90 };
      return { ok: true, status: 200, json: async () => payload };
    }
  });
  vm.runInContext(source, context);
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
  await settle();
  return { el, requests, settle, windowHandlers };
}

test("改变语种、勾选项、音量和区服后，全新窗口从文件配置恢复", async () => {
  const config: any = { defaultLocale: "ja_JP" };
  const first = await openWindow(config);
  first.el("selectMenu").children[2].onclick!();
  first.el("modIngameLang").checked = false;
  first.el("modIngameLang").handlers.change?.();
  first.el("volumeSlider").value = "23";
  first.el("volumeSlider").handlers.input();
  first.el("btnServerRegion").onclick!();
  await first.settle();
  assert.equal(config.ui?.selectedLocale, "ko_KR");
  assert.deepEqual(config.ui.modules, ["ingame_voice", "lobby_voice"]);
  assert.equal(config.ui.volume, 23);
  assert.equal(config.ui.followClient, false);
  const second = await openWindow(structuredClone(config));
  assert.equal(second.el("localeSelect").value, "ko_KR");
  assert.equal(second.el("modIngameLang").checked, false);
  assert.equal(second.el("volumeSlider").value, "23");
  assert.equal(second.el("btnAlignVolume").dataset.on, "false");
  assert.equal(second.el("regionText").textContent, "外服");
  assert.ok(second.requests.some((r) => r.url === "/api/client-voice"));
});

test("明确取消语种、关闭所有模块和静音在启动后仍保留，不启动监听", async () => {
  const config = { defaultLocale: "ja_JP", ui: { selectedLocale: "", modules: [], volume: 0, followClient: false, region: "cn" } };
  const page = await openWindow(config);
  assert.equal(page.el("localeSelect").value, "");
  assert.equal(page.el("modIngameVoice").checked, false);
  assert.equal(page.el("modLobbyVoice").checked, false);
  assert.equal(page.el("volumeSlider").value, "0");
  assert.ok(!page.requests.some((r) => r.url === "/api/lobby-live/start"));
});

test("配置优先于旧浏览器缓存，第一次启动将旧音量迁入文件", async () => {
  const config: any = { defaultLocale: "ja_JP" };
  const first = await openWindow(config, { "leagueVoice.volume": "31", "leagueVoice.followClient": "0" });
  assert.equal(first.el("volumeSlider").value, "31");
  assert.equal(config.ui.volume, 31);
  const second = await openWindow(config, { "leagueVoice.volume": "80", "leagueVoice.followClient": "1" });
  assert.equal(second.el("volumeSlider").value, "31");
});

test("保存失败明确显示失败，不显示已保存", async () => {
  const page = await openWindow({ defaultLocale: "ja_JP", ui: { selectedLocale: "ja_JP", modules: [], volume: 60, followClient: false, region: "cn" } }, {}, true);
  page.el("volumeSlider").value = "19";
  page.el("volumeSlider").handlers.input();
  await page.settle();
  assert.match(page.el("configSaveStatus").textContent, /保存失败/);
});

test("快速拖动后立即关闭，提交最新配置，不被队列中的旧音量覆盖", async () => {
  const config: any = { defaultLocale: "ja_JP", ui: { selectedLocale: "", modules: [], volume: 60, followClient: false, region: "cn" } };
  const page = await openWindow(config);
  for (const value of ["15", "37", "0"]) {
    page.el("volumeSlider").value = value;
    page.el("volumeSlider").handlers.input();
  }
  page.windowHandlers.pagehide();
  await page.settle();
  assert.equal(config.ui.volume, 0);
  const saves = page.requests.filter((r) => r.options.method === "PUT");
  assert.equal(saves.length, 1);
  assert.equal(saves[0].options.keepalive, true);
});

test("原版台词开关使用实际请求函数并发送 JSON", async () => {
  const page = await openWindow({ defaultLocale: "ja_JP", ui: { selectedLocale: "", modules: [], volume: 60, followClient: false, region: "auto" } });
  await page.el("btnClientVoice").handlers.click();
  const post = page.requests.find((r) => r.url === "/api/client-voice" && r.options.method === "POST");
  assert.deepEqual(JSON.parse(post!.options.body), { auto: false });
});
