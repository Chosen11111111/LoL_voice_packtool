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
async function openWindow(config: any, legacy: Record<string, string> = {}, failSave = false, stateExtra: Record<string, unknown> = {}, saveGate?: Promise<void>) {
  const elements = new Map<string, Element>();
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const requests: { url: string; options: any }[] = [];
  const windowHandlers: Record<string, Function> = {};
  const opened: string[] = [];
  const window = {
    addEventListener(name: string, fn: Function) { windowHandlers[name] = fn; },
    open: (url: string) => { opened.push(url); return null; }
  };
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
          await saveGate;
          if (failSave) return { ok: false, status: 500, json: async () => ({ error: "write_failed", message: "磁盘写入失败" }) };
          const patch = JSON.parse(options.body);
          Object.assign(config, { ...patch, ui: { ...config.ui, ...patch.ui } });
        }
        payload = { ok: true, config: structuredClone(config), path: "test/config.json" };
      } else if (url === "/api/state") payload.state = { app: { version: "test" }, paths: {}, busy: {}, ingame: {}, lobby: {}, hide_enable_tip: true, ...stateExtra };
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
  return { el, requests, settle, windowHandlers, opened };
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
  assert.equal(page.el("statusLobbyVoice").textContent, "原版", "界面也要显示未开启(统一文案: 原版)");
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

test("下载语音包: 弹窗只放链接和提取码, 点 × 关闭", async () => {
  const config = { selectedLocale: "ja_JP", modules: ["lobby_voice"], volume: 60, followClient: false, voiceDelayMs: 1000, lastApplied: null, region: "auto" };
  const page = await openWindow({ defaultLocale: "ja_JP", ui: config }, {}, false, { last_applied: null });
  await page.settle();

  const modal = page.el("packDownloadModal");
  modal.classList.add("hidden"); // 沙箱元素是空的, 补上 HTML 里初始的 hidden
  assert.equal(modal.classList.contains("hidden"), true, "默认不显示");

  page.el("btnPackDownload").onclick!();
  await page.settle();
  assert.equal(modal.classList.contains("hidden"), false, "点『下载语音包』应弹出");
  assert.equal(page.el("packDownloadLink").value, "https://pan.quark.cn/s/faa460d28263");
  assert.equal(page.el("packDownloadCode").value, "U3Dw");

  page.el("btnClosePackDownload").onclick!();
  await page.settle();
  assert.equal(modal.classList.contains("hidden"), true, "点 × 应关闭");
  assert.equal(page.el("btnClosePackDownload").textContent, "", "× 是图标按钮, 不放文字");
});

test("品牌图是一个按钮: 点击会打开品牌链接", async () => {
  const config = { selectedLocale: "ja_JP", modules: ["lobby_voice"], volume: 60, followClient: false, voiceDelayMs: 1000, lastApplied: null, region: "auto" };
  const page = await openWindow({ defaultLocale: "ja_JP", ui: config }, {}, false, { last_applied: null });
  await page.settle();
  page.el("btnBrand").onclick!();
  await page.settle();
  // 现在优先请后端用系统浏览器打开(外壳不处理"新窗口"请求, 直接 window.open 点了没反应)
  const call = (page as any).requests.find((item: any) => String(item.url).includes("/api/open-url"));
  assert.ok(call, "点一下应向 /api/open-url 发一次请求");
  assert.ok(String(call.options.body).includes("https://chosen1.lol"), "品牌链接指向 chosen1.lol");
  // 后端失败时才退回 window.open; 走通那条路就不该再开一个
  const opened = (page as any).opened;
  if (opened.length) assert.equal(opened[0], "https://chosen1.lol", "退回 window.open 时也指向 chosen1.lol");
});

test("开启语音包: 没点过『不再提醒』时先弹提示, 点确定才真的开启", async () => {
  const config: any = { selectedLocale: "ja_JP", modules: ["ingame_voice"], volume: 60, followClient: false, voiceDelayMs: 1000, lastApplied: null, region: "auto" };
  const page = await openWindow({ defaultLocale: "ja_JP", ui: config }, {}, false, { last_applied: null, hide_enable_tip: false });
  page.el("btnApply").onclick!();
  await page.settle();
  // 沙箱没有真实 DOM, 所以断言行为: 弹窗挡住时不会发 /api/apply
  assert.ok(!page.requests.some((r) => r.url === "/api/apply"), "还没确认, 不应该真的开启");

  page.el("btnEnableTipOk").onclick!();
  await page.settle();
  assert.ok(page.requests.some((r) => r.url === "/api/apply"), "点确定后才开启");
});

test("开启语音包: 点『不再提醒』会存下来并继续开启, 之后不再弹", async () => {
  const config: any = { selectedLocale: "ja_JP", modules: ["ingame_voice"], volume: 60, followClient: false, voiceDelayMs: 1000, lastApplied: null, region: "auto" };
  const page = await openWindow({ defaultLocale: "ja_JP", ui: config }, {}, false, { last_applied: null, hide_enable_tip: false });
  page.el("btnApply").onclick!();
  await page.settle();
  page.el("btnEnableTipNever").onclick!();
  await page.settle();
  const saved = page.requests.find((r) => r.url === "/api/ui/hide-enable-tip");
  assert.ok(saved, "应把『不再提醒』存到配置");
  assert.equal(saved!.options.method, "POST");
  assert.ok(page.requests.some((r) => r.url === "/api/apply"), "并且继续开启");

  // 已经记住之后, 再点就不弹了
  const next = await openWindow({ defaultLocale: "ja_JP", ui: structuredClone(config) }, {}, false, { last_applied: null, hide_enable_tip: true });
  next.el("btnApply").onclick!();
  await next.settle();
  // 没弹窗挡着 => 点下去直接发请求
  assert.ok(next.requests.some((r) => r.url === "/api/apply"), "已记住设置, 直接开启不再弹提示");
  assert.ok(!next.requests.some((r) => r.url === "/api/ui/hide-enable-tip"), "也不该再写一次设置");
});

test("开启语音包: 提示弹窗的 × 等于取消这次开启", async () => {
  const config: any = { selectedLocale: "ja_JP", modules: ["ingame_voice"], volume: 60, followClient: false, voiceDelayMs: 1000, lastApplied: null, region: "auto" };
  const page = await openWindow({ defaultLocale: "ja_JP", ui: config }, {}, false, { last_applied: null, hide_enable_tip: false });
  page.el("btnApply").onclick!();
  await page.settle();
  page.el("btnCloseEnableTip").onclick!();
  await page.settle();
  assert.ok(!page.requests.some((r) => r.url === "/api/apply"), "取消(×)就不应该开启");
  // 再点一次应该重新弹提示(依然不直接开启)
  page.el("btnApply").onclick!();
  await page.settle();
  assert.ok(!page.requests.some((r) => r.url === "/api/apply"), "重按仍要先弹提示");
});

test("开启语音包: 明确要求重启客户端(客户端在运行时会自动重启生效)", async () => {
  const config: any = { selectedLocale: "ja_JP", modules: ["ingame_voice"], volume: 60, followClient: false, voiceDelayMs: 1000, lastApplied: null, region: "auto" };
  const page = await openWindow({ defaultLocale: "ja_JP", ui: config }, {}, false, { last_applied: null, hide_enable_tip: true });
  page.el("btnApply").onclick!();
  await page.settle();
  const apply = page.requests.find((r) => r.url === "/api/apply");
  assert.ok(apply, "应该发出 /api/apply");
  const body = JSON.parse(apply!.options.body);
  assert.equal(body.restartClient, true, "要带上 restartClient: true, 后端才会在客户端运行时帮用户重启");
  assert.equal(body.locale, "ja_JP");
  assert.deepEqual(body.modules, ["ingame_voice"]);
});

test("刚切外服就点开启，必须等区服配置保存完再提交任务", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const config: any = { defaultLocale: "ja_JP", ui: { selectedLocale: "ja_JP", modules: ["ingame_voice"], volume: 60, followClient: false, voiceDelayMs: 1000, region: "cn" } };
  const page = await openWindow(config, {}, false, { hide_enable_tip: true }, gate);
  page.el("btnServerRegion").onclick!();
  page.el("btnApply").onclick!();
  await page.settle();
  try {
    assert.ok(!page.requests.some((r) => r.url === "/api/apply"), "配置还没写完不能用旧渠道启动任务");
  } finally { release(); }
  await page.settle();
  assert.equal(config.ui.region, "global");
  assert.ok(page.requests.some((r) => r.url === "/api/apply"));
});

test("区服配置保存失败时阻止切换，不继续用旧配置执行", async () => {
  const config: any = { defaultLocale: "ja_JP", ui: { selectedLocale: "ja_JP", modules: ["ingame_voice"], volume: 60, followClient: false, voiceDelayMs: 1000, region: "cn" } };
  const page = await openWindow(config, {}, true, { hide_enable_tip: true });
  page.el("btnServerRegion").onclick!();
  page.el("btnApply").onclick!();
  await page.settle();
  assert.ok(!page.requests.some((r) => r.url === "/api/apply"));
  assert.match(page.el("statusText").textContent, /配置.*保存/);
});

test("外服未替换时状态显示原版，不显示国服", async () => {
  const page = await openWindow({ defaultLocale: "ja_JP", ui: { selectedLocale: "ja_JP", modules: [], volume: 60, followClient: false, voiceDelayMs: 1000, region: "global" } });
  // 状态词统一成两个: 没开是"原版", 开了是"已开启"
  assert.equal(page.el("statusIngameVoice").textContent, "原版");
  assert.equal(page.el("statusIngameLang").textContent, "原版");
});
