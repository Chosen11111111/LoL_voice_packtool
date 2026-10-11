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
  private classes = new Set<string>();
  classList = {
    add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
    toggle: (name: string, force?: boolean) => {
      if (force === undefined) {
        if (this.classes.has(name)) { this.classes.delete(name); return false; }
        this.classes.add(name);
        return true;
      }
      if (force) { this.classes.add(name); return true; }
      this.classes.delete(name);
      return false;
    },
    contains: (name: string) => this.classes.has(name)
  };
  set innerHTML(_: string) { this.children = []; }
  appendChild(child: Element) { this.children.push(child); }
  addEventListener(name: string, fn: Function) { this.handlers[name] = fn; }
  setAttribute() {} contains() { return false; }
}
async function openWindow(config: any, legacy: Record<string, string> = {}, failSave = false, stateExtra: Record<string, unknown> = {}) {
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
      } else if (url === "/api/state") payload.state = { app: { version: "test" }, paths: {}, busy: {}, ingame: {}, lobby: {}, ...stateExtra };
      else if (url.startsWith("/api/locales")) payload.locales = [{ code: "ja_JP", name: "日语" }, { code: "ko_KR", name: "韩语" }];
      else if (url === "/api/client-voice") payload = { ok: true, supported: true, auto: true, aligned_volume: 90 };
      else if (url === "/api/apply") {
        const body = JSON.parse(options.body);
        stateExtra.last_applied = { locale: body.locale, modules: body.modules, at: new Date().toISOString() };
        payload = { ok: true, task: { id: "t1" } };
      } else if (url === "/api/restore") {
        stateExtra.last_applied = null;
        payload = { ok: true, task: { id: "t1" } };
      }
      else if (url.startsWith("/api/tasks/")) payload = { ok: true, task: { id: "t1", status: "succeeded" }, result: { message: "测试任务完成" } };
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

test("播报延迟: 写入配置并在新窗口恢复(含边界钳制)", async () => {
  const config: any = { defaultLocale: "ja_JP", ui: { selectedLocale: "", modules: [], volume: 60, followClient: false, voiceDelayMs: null, region: "auto" } };
  const first = await openWindow(config);
  first.el("delayInput").value = "250";
  first.el("delayInput").handlers.change();
  await first.settle();
  assert.equal(config.ui.voiceDelayMs, 250, "延迟应写入配置");

  // 新窗口从配置恢复
  const second = await openWindow(config);
  assert.equal(second.el("delayInput").value, "250");

  // 越界值被钳制(负数 -> 0, 超大 -> 3000)
  second.el("delayInput").value = "-50";
  second.el("delayInput").handlers.change();
  assert.equal(second.el("delayInput").value, "0");
  second.el("delayInput").value = "99999";
  second.el("delayInput").handlers.change();
  assert.equal(second.el("delayInput").value, "3000");
});

test("播报延迟默认 1000ms(把实测最好用的值固定下来)", async () => {
  const config: any = { defaultLocale: "ja_JP", ui: { selectedLocale: "", modules: [], volume: 60, followClient: false, region: "auto" } };
  const page = await openWindow(config);
  assert.equal(page.el("delayInput").value, "1000");
});

test("选人语音不自动开启: 没有开启记录时绝不启动监听", async () => {
  const ui = { selectedLocale: "ja_JP", modules: ["lobby_voice"], volume: 60, followClient: false, voiceDelayMs: 1000, lastApplied: null, region: "auto" };
  const page = await openWindow({ defaultLocale: "ja_JP", ui }, {}, false, { last_applied: null });
  await page.settle();
  assert.equal(page.requests.filter((r) => r.url === "/api/lobby-live/start").length, 0, "勾了选人语音但没点开启语音包, 不该启动监听");
});

test("退出即清零: 重启后即使上次开启过也不自动启动监听", async () => {
  const ui = { selectedLocale: "ja_JP", modules: ["lobby_voice"], volume: 60, followClient: false, voiceDelayMs: 1000, lastApplied: null, region: "auto" };
  const page = await openWindow({ defaultLocale: "ja_JP", ui }, {}, false, {
    last_applied: { locale: "ko_KR", modules: ["lobby_voice"], at: new Date("2026-10-11T12:30:00").toISOString() }
  });
  await page.settle();
  assert.equal(
    page.requests.filter((r) => r.url === "/api/lobby-live/start").length,
    0,
    "关掉软件再打开不该自己开起来; last_applied 只作为『上次开启』的记录"
  );
  assert.equal(page.el("statusLobbyVoice").textContent, "【当前为：未开启】", "界面也要显示未开启");
});

test("上次开启没勾选人语音 -> 重启后不启动监听", async () => {
  const ui = { selectedLocale: "ja_JP", modules: ["lobby_voice"], volume: 60, followClient: false, voiceDelayMs: 1000, lastApplied: null, region: "auto" };
  const page = await openWindow({ defaultLocale: "ja_JP", ui }, {}, false, {
    last_applied: { locale: "ja_JP", modules: ["ingame_voice"], at: new Date("2026-10-11T12:30:00").toISOString() }
  });
  await page.settle();
  assert.equal(page.requests.filter((r) => r.url === "/api/lobby-live/start").length, 0);
});

test("播报音量自动对齐客户端: 选中选人语音并开启后, 音量取客户端总音量", async () => {
  const ui = { selectedLocale: "ja_JP", modules: ["lobby_voice"], volume: 20, followClient: false, voiceDelayMs: 1000, lastApplied: null, region: "auto" };
  const page = await openWindow({ defaultLocale: "ja_JP", ui }, {}, false, {
    last_applied: { locale: "ja_JP", modules: ["lobby_voice"], at: new Date("2026-10-11T12:30:00").toISOString() }
  });
  await page.settle();
  // 沙箱里客户端音量返回 90; 即使配置里存的是 20, 也应被客户端的音量覆盖
  assert.equal(page.el("volumeSlider").value, "90");
});

test("选人语音未开启时, 播报音量不跟随客户端", async () => {
  const ui = { selectedLocale: "ja_JP", modules: ["lobby_voice"], volume: 20, followClient: false, voiceDelayMs: 1000, lastApplied: null, region: "auto" };
  const page = await openWindow({ defaultLocale: "ja_JP", ui }, {}, false, { last_applied: null });
  await page.settle();
  assert.equal(page.el("volumeSlider").value, "20", "状态未开启时用配置里的音量");
});

test("换语种: 直接原地切换, 不能先停(否则会还原客户端设置再静音, 看着像没关上)", async () => {
  const ui = { selectedLocale: "ja_JP", modules: ["lobby_voice"], volume: 60, followClient: false, voiceDelayMs: 1000, lastApplied: null, region: "auto" };
  const page = await openWindow({ defaultLocale: "ja_JP", ui }, {}, false, { last_applied: null });
  await page.settle();
  page.el("modLobbyVoice").checked = true; // 勾选"选人语音"(沙箱里默认未勾)

  const applyFor = async (menuIndex: number) => {
    page.el("selectMenu").children[menuIndex].onclick!(); // 切语种
    page.el("btnApply").onclick!();
    await new Promise((resolve) => setTimeout(resolve, 500)); // 等 waitTask 轮询一轮(350ms)
    await page.settle();
  };

  await applyFor(2); // ko_KR
  await applyFor(1); // ja_JP

  assert.equal(
    page.requests.filter((r) => r.url === "/api/lobby-live/stop").length,
    0,
    "换语种不该发 stop —— 停了会先还原客户端设置再重新静音, 用户看到的就是『设置里没关上』"
  );
  const starts = page.requests.filter((r) => r.url === "/api/lobby-live/start");
  assert.ok(starts.length >= 2, "每次开启都应走 start(后端原地换语种)");
  assert.equal(JSON.parse(starts[starts.length - 1]!.options.body).locale, "ja_JP", "最后用的是新语种");
});

test("下载语音包: 弹窗显示网盘链接/提取码, 并能直接从路径导入(不走上传)", async () => {
  const ui = { selectedLocale: "ja_JP", modules: ["lobby_voice"], volume: 60, followClient: false, voiceDelayMs: 1000, lastApplied: null, region: "auto" };
  const page = await openWindow({ defaultLocale: "ja_JP", ui }, {}, false, { last_applied: null });
  await page.settle();

  const modal = page.el("packDownloadModal");
  modal.classList.add("hidden"); // 沙箱元素是空的, 补上 HTML 里初始的 hidden
  assert.equal(modal.classList.contains("hidden"), true, "默认不显示");
  page.el("btnPackDownload").onclick!();
  await page.settle();
  assert.equal(modal.classList.contains("hidden"), false, "点『下载语音包』应弹出");
  assert.equal(page.el("packDownloadLink").value, "https://pan.baidu.com/s/1ymzAEQ_GzHOcwXWThqakbQ?pwd=q3gf");
  assert.equal(page.el("packDownloadCode").value, "q3gf");

  page.el("packImportPath").value = "D:\\packs\\voice.zip";
  page.el("btnImportPackPath").onclick!();
  await page.settle();
  const request = page.requests.find((item) => item.url === "/api/packs/import" && item.options.method === "POST");
  assert.ok(request, "应把路径交给后端导入");
  assert.equal(JSON.parse(request!.options.body).path, "D:\\packs\\voice.zip", "走路径导入, 不经过浏览器上传");
  assert.equal(modal.classList.contains("hidden"), true, "导入后自动关掉弹窗");
});
