/* 英雄联盟语音包切换器 —— 五排精致蓝白毛玻璃界面逻辑 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MAX_LOG = 500;

  /** 品牌图点开的链接(要换只改这一处)。 */
  const BRAND_LINK = "https://chosen1.lol";

  /** 语音包网盘下载信息(要换下载地址只改这一处)。 */
  const PACK_DOWNLOAD = {
    url: "https://pan.baidu.com/s/1ymzAEQ_GzHOcwXWThqakbQ?pwd=q3gf",
    code: "q3gf"
  };

  const store = {
    state: null,
    locales: [],
    customPacks: [],
    config: null,
    selected: "",
    region: "cn",
    logs: [],
    busy: false,
    taskId: null
  };

  /* ------------------------------------------------ 基础工具 */

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function log(line) {
    if (releaseMode) return; // 发布包不记日志
    const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    for (const raw of String(line).split("\n")) {
      store.logs.push("[" + stamp + "] " + raw);
    }
    if (store.logs.length > MAX_LOG) {
      store.logs.splice(0, store.logs.length - MAX_LOG);
    }
    const box = $("logBox");
    if (box) {
      box.textContent = store.logs.join("\n") || "[就绪]";
      box.scrollTop = box.scrollHeight;
    }
  }

  function setStatus(text, kind, percent) {
    $("statusText").textContent = text;
    const dot = $("statusDot");
    dot.classList.remove("ok", "err");
    if (kind === "ok") dot.classList.add("ok");
    if (kind === "err") dot.classList.add("err");
    if (typeof percent === "number") {
      $("progressFill").style.width = Math.max(0, Math.min(100, percent)) + "%";
    }
  }

  // 客户端是否在运行(null = 还不知道)。"开启语音包"要求客户端在跑, 因为选人语音必须连 LCU
  let clientRunning = null;

  // 只有勾选了"选人语音"(lobby_voice)才需要客户端在运行 —— 它必须连 LCU
  function lobbyVoiceNeedsClient() {
    const box = $("modLobbyVoice");
    return Boolean(box && box.checked) && clientRunning === false;
  }

  function applyDisabledStates() {
    const busy = Boolean(store.busy);
    const clientDown = lobbyVoiceNeedsClient();
    for (const id of [
      "btnAutoSearchPath",
      "btnConfirmPath",
      "btnServerRegion",
      "btnChooseLocale",
      "btnRestore",
      "btnApply",
      "selectTrigger"
    ]) {
      const el = $(id);
      if (!el) continue;
      // 恢复原版永远可用(出问题时要能还原)
      const blockedByClient = id === "btnApply" && clientDown;
      el.disabled = busy || blockedByClient;
      if (id === "btnApply") {
        el.title = clientDown
          ? "勾选了选人语音，但英雄联盟没在运行：先启动客户端并登录到大厅（只勾对局语音/语言不需要）"
          : "";
      }
    }
  }

  function setBusy(busy) {
    store.busy = busy;
    applyDisabledStates();
  }

  async function api(path, options) {
    const response = await fetch(
      path,
      Object.assign({ headers: { "Content-Type": "application/json" } }, options || {})
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok || (payload && payload.ok === false && payload.error)) {
      throw new Error((payload && payload.message) || "HTTP " + response.status);
    }
    return payload;
  }

  function selectedModules() {
    const modules = [];
    if ($("modIngameVoice").checked) modules.push("ingame_voice");
    if ($("modIngameLang").checked) modules.push("ingame_lang");
    if ($("modLobbyVoice").checked) modules.push("lobby_voice");
    return modules;
  }

  /** 上次"开启语音包"的记录(重启后仍能显示当前生效的是什么)。 */
  let lastApplied = null;
  /** 用户点过『不再提醒』后为 true(来自配置)。 */
  let hideEnableTip = false;

  /** 发布包: 不记日志、也不显示日志入口(用户包不需要这些)。 */
  let releaseMode = false;

  let preferencesReady = false;
  let preferencesDirty = false;
  let preferenceRevision = 0;
  let preferenceQueue = Promise.resolve();
  let preferenceRegion = "auto";
  let pageClosing = false;
  const moduleControls = { ingame_voice: "modIngameVoice", ingame_lang: "modIngameLang", lobby_voice: "modLobbyVoice" };

  function preferenceSnapshot() {
    return {
      selectedLocale: store.selected,
      modules: selectedModules(),
      volume,
      followClient,
      voiceDelayMs,
      region: preferenceRegion
    };
  }

  function savePreferences() {
    if (!preferencesReady) return Promise.resolve();
    const ui = preferenceSnapshot();
    const revision = ++preferenceRevision;
    preferencesDirty = true;
    $("configSaveStatus").textContent = "配置保存中…";
    preferenceQueue = preferenceQueue.then(async () => {
      // 连续拖动时只写最新快照，避免把每一个中间音量排队写盘。
      if (pageClosing || revision !== preferenceRevision) return;
      try {
        await api("/api/config", { method: "PUT", body: JSON.stringify({ ui }), keepalive: true });
        if (revision === preferenceRevision) {
          preferencesDirty = false;
          $("configSaveStatus").textContent = "配置已保存";
        }
      } catch (error) {
        if (revision === preferenceRevision) $("configSaveStatus").textContent = "配置保存失败";
        log("配置保存失败：" + error.message);
      }
    });
    return preferenceQueue;
  }

  function restorePreferences(config, file) {
    const ui = config.ui || {};
    store.selected = typeof ui.selectedLocale === "string" ? ui.selectedLocale : config.defaultLocale || "";
    const modules = Array.isArray(ui.modules) ? ui.modules : Object.keys(moduleControls);
    for (const [module, id] of Object.entries(moduleControls)) $(id).checked = modules.includes(module);
    if (typeof ui.volume === "number" && Number.isFinite(ui.volume)) setVolume(ui.volume, false);
    followClient = typeof ui.followClient === "boolean" ? ui.followClient : followClient;
    if (typeof ui.voiceDelayMs === "number" && Number.isFinite(ui.voiceDelayMs)) setVoiceDelay(ui.voiceDelayMs, false);
    if (ui.region === "cn" || ui.region === "global") {
      preferenceRegion = ui.region;
      setServerRegion(ui.region, true);
    }
    applyFollowLabel();
    preferencesReady = true;
    $("configSaveStatus").title = "配置文件：" + file;
    $("configSaveStatus").textContent = "配置已读取";
    if (ui.volume == null || ui.followClient == null || ui.selectedLocale == null) void savePreferences();
  }

  // 关闭时将尚未落盘的最新选择提交，keepalive 允许请求在窗口关闭后完成。
  window.addEventListener("pagehide", () => {
    pageClosing = true;
    if (!preferencesReady || !preferencesDirty) return;
    void fetch("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ui: preferenceSnapshot() }), keepalive: true }).catch(() => undefined);
  });
  window.addEventListener("pageshow", () => { pageClosing = false; });

  function cleanStatusDetail(raw, isActive, fallbackLocale) {
    if (!isActive) return "客户端原版文件";
    const cleaned = String(raw || "")
      .replace(/[【】]/g, "")
      .replace(/^已切换为：/, "")
      .replace(/^当前为：/, "")
      .trim();
    if (cleaned && cleaned !== "已开启") return cleaned;
    if (fallbackLocale) return fallbackLocale;
    return "已替换为语音包";
  }

  function detectRegionFromPath(pathStr, sourceDetail) {
    const raw = String(pathStr || "").trim();
    const detail = String(sourceDetail || "").trim();
    if (!raw) return null;

    // 外服路径特征：Riot Games 或纯英文 League of Legends 安装目录（不含 WeGame/Tencent/英雄联盟）
    if (
      /riot\s*games/i.test(raw) ||
      /riot/i.test(detail) ||
      (/league\s*of\s*legends/i.test(raw) && !/wegame|tencent|英雄联盟|tcls/i.test(raw))
    ) {
      return "global";
    }

    // 国服路径特征：含 英雄联盟 / WeGame / Tencent / TCLS / LeagueClient
    if (
      /英雄联盟|wegame|tencent|tcls|leagueclient/i.test(raw) ||
      /tencent/i.test(detail)
    ) {
      return "cn";
    }

    return null;
  }

  /** 渠道(国服/外服)的实际方式由后端判定: 取回来挂在按钮上, 便于确认按钮真的生效。 */
  async function loadRegionInfo() {
    try {
      const info = await api("/api/client");
      if (!info || !info.region_label) return;
      const button = $("btnServerRegion");
      if (button) button.title = "当前方式：" + info.region_label + "（" + (info.region_source === "ui" ? "右上角按钮指定" : "按客户端路径探测") + "）\n" + (info.region_detail || "");
      if (info.region_source === "ui" && info.region_detail && lastRegionLogged !== info.region_label + info.region_detail) {
        lastRegionLogged = info.region_label + info.region_detail;
        log("当前方式：" + info.region_label + " —— " + info.region_detail + "（基准语种 " + info.base_locale + "）");
      }
    } catch {
      /* ignore */
    }
  }

  function setServerRegion(targetRegion, silent) {
    if (!targetRegion || store.region === targetRegion) {
      // 原本就是该区服则不用切换
      return;
    }
    store.region = targetRegion;
    const label = store.region === "cn" ? "国服" : "外服";
    const btn = $("btnServerRegion");
    const textEl = $("regionText");
    if (btn) btn.dataset.region = store.region;
    if (textEl) textEl.textContent = label;
    if (!silent) {
      log("根据游戏路径自动切换为：" + label);
    }
  }

  /* ------------------------------------------------ 自定义毛玻璃下拉栏 */

  function allLocaleItems() {
    const merged = [...store.locales];
    for (const pack of store.customPacks) {
      if (!merged.some((item) => item.code === pack.code)) {
        merged.push(pack);
      }
    }
    return merged;
  }

  function closeCustomDropdown() {
    $("customLocaleSelect").classList.remove("open");
    $("selectMenu").classList.add("hidden");
    $("selectTrigger").setAttribute("aria-expanded", "false");
  }

  function selectLocaleValue(code, notify) {
    store.selected = code || "";
    if (notify) void savePreferences();
    // 注意: 选择语种不改变"选人语音"的开关状态 —— 那要点了"开启语音包"才算
    const select = $("localeSelect");
    select.value = store.selected;

    const items = allLocaleItems();
    const found = items.find((item) => item.code === store.selected);
    const labelEl = $("selectLabel");
    if (found) {
      labelEl.textContent = found.name || found.code;
      labelEl.classList.remove("placeholder");
      if (notify) {
        log("已选中语音包：" + (found.name || found.code));
        setStatus("已选中语音包：" + (found.name || found.code), "ok");
      }
    } else {
      labelEl.textContent = "未选中语音包";
      labelEl.classList.add("placeholder");
      if (notify) {
        setStatus("未选中语音包", "");
      }
    }
    renderLocaleRow();
    void syncTextPackLocale();
  }

  function renderLocaleRow() {
    const select = $("localeSelect");
    const menu = $("selectMenu");
    const items = allLocaleItems();

    select.innerHTML = '<option value="">未选中语音包</option>';
    menu.innerHTML = "";

    // 默认未选中项
    const emptyOpt = document.createElement("div");
    emptyOpt.className = "select-option" + (!store.selected ? " active" : "");
    emptyOpt.innerHTML = '<span>未选中语音包</span>';
    emptyOpt.onclick = () => {
      closeCustomDropdown();
      selectLocaleValue("", true);
    };
    menu.appendChild(emptyOpt);

    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item.code;
      opt.textContent = item.name || item.code;
      select.appendChild(opt);

      const row = document.createElement("div");
      row.className = "select-option" + (store.selected === item.code ? " active" : "");
      const badgeText = item.active ? "当前生效" : item.code;
      row.innerHTML =
        "<span>" + escapeHtml(item.name || item.code) + "</span>" +
        '<span class="select-option-tag">' + escapeHtml(badgeText) + "</span>";
      row.onclick = () => {
        closeCustomDropdown();
        selectLocaleValue(item.code, true);
      };
      menu.appendChild(row);
    }

    const found = items.find((item) => item.code === store.selected);
    const labelEl = $("selectLabel");
    if (found) {
      select.value = found.code;
      labelEl.textContent = found.name || found.code;
      labelEl.classList.remove("placeholder");
    } else {
      select.value = "";
      labelEl.textContent = "未选中语音包";
      labelEl.classList.add("placeholder");
    }
  }

  /* ------------------------------------------------ 渲染各排状态 */

  function renderPathRow() {
    const input = $("leaguePathInput");
    const configured = store.config && store.config.leaguePath;
    const detected = store.state && store.state.paths && store.state.paths.leagueDir;
    const sourceDetail = store.state && store.state.paths && store.state.paths.sourceDetail;
    const currentPath = configured || detected || "";
    if (document.activeElement !== input) {
      input.value = currentPath;
    }
    const detectedRegion = detectRegionFromPath(input.value || currentPath, sourceDetail);
    if (detectedRegion && preferenceRegion === "auto") {
      setServerRegion(detectedRegion, false);
    }
  }

  const MODULE_NAMES = {
    ingame_voice: "对局语音",
    ingame_lang: "对局文字",
    lobby_voice: "选人语音",
    lobby_lang: "大厅语言"
  };

  let lastAppliedLogged = "";
  let lastAppliedWarned = "";
  /**
   * 本次会话是否开启了选人语音。
   * 启动时恒为 false —— 关软件再打开不会自己开起来(用户要求"退出即清零")。
   */
  let lobbyVoiceSessionOn = false;
  /** 渠道说明只记一次日志, 免得每轮刷新都刷屏。 */
  let lastRegionLogged = "";
  /** 监听器的启动/停止串行队列(避免并发起两个监听器)。 */
  let syncQueue = Promise.resolve();

  /** 选人语音的开关状态(只看状态, 不看勾选框)。 */
  function lobbyVoiceStateOn() {
    return Boolean(lastApplied && lastApplied.locale && (lastApplied.modules || []).includes("lobby_voice"));
  }

  /** "上次开启"的简短文案(用于悬停提示与日志)。 */
  function lastAppliedText() {
    if (!lastApplied || !lastApplied.locale) return "";
    const localeName = (store.locales.find((item) => item.code === lastApplied.locale) || {}).name || lastApplied.locale;
    const modules = (lastApplied.modules || []).map((item) => MODULE_NAMES[item] || item).join("+") || "未记录";
    const when = lastApplied.at ? new Date(lastApplied.at) : null;
    const stamp = when && !Number.isNaN(when.getTime())
      ? (when.getMonth() + 1) + "-" + when.getDate() + " " + String(when.getHours()).padStart(2, "0") + ":" + String(when.getMinutes()).padStart(2, "0")
      : "";
    return "上次开启：" + localeName + "（" + modules + "）" + (stamp ? " · " + stamp : "");
  }

  /**
   * 有异常时才提示(默认不占地方, 保持三格状态区风格统一):
   * 记录里含对局模块但磁盘已是原版 -> 说明被还原过或被客户端更新覆盖。
   */
  function warnIfLastAppliedStale(ingame) {
    if (!lastApplied || !lastApplied.locale) return;
    const ingameInRecord = (lastApplied.modules || []).some((item) => item === "ingame_voice" || item === "ingame_lang");
    if (!ingameInRecord) return;
    if (ingame.is_voice_active || ingame.is_lang_active) return;
    const text = lastAppliedText();
    if (lastAppliedWarned === text) return;
    lastAppliedWarned = text;
    log(text + " —— 但游戏内文件现在是原版，可能已被还原或被客户端更新覆盖，需要重新点『开启语音包』");
    setStatus("上次开启的对局补丁已失效，需要重新点『开启语音包』", "warn", 0);
  }

  function renderStatusRow() {
    const state = store.state;
    if (!state) return;

    const ingame = state.ingame || {};
    const lobby = state.lobby || {};

    // 1. 游戏内语音及播报员
    const voiceActive = Boolean(ingame.is_voice_active);
    $("cardStatusVoice").classList.toggle("active", voiceActive);
    $("tagStatusVoice").textContent = voiceActive ? "语音包" : "原版";
    $("statusIngameVoice").textContent = cleanStatusDetail(ingame.voice, voiceActive, ingame.active_locale);

    // 2. 游戏内文字
    const langActive = Boolean(ingame.is_lang_active);
    $("cardStatusLang").classList.toggle("active", langActive);
    $("tagStatusLang").textContent = langActive ? "语音包" : "原版";
    $("statusIngameLang").textContent = cleanStatusDetail(ingame.lang, langActive, ingame.active_locale);

    // 3. 对局前选人语音: 走 "LCU 监听 + 本地播放", 状态以后端的监听引擎为准
    const live = store.state.lobby_live || {};
    const lobbyActive = Boolean(live.running);
    const liveLocale = live.locale || lobby.locale || "";
    const lobbyLocaleObj = store.locales.find((item) => item.code === liveLocale);
    const lobbyLocaleName = lobbyLocaleObj ? lobbyLocaleObj.name : liveLocale;
    $("cardStatusLobby").classList.toggle("active", lobbyActive);
    // 这一格的口径是"状态": 上次开启时勾了选人语音, 状态就是开启
    const lobbyStateOn = Boolean(lastApplied && (lastApplied.modules || []).includes("lobby_voice"));
    $("tagStatusLobby").textContent = lobbyActive ? "实时播报" : lobbyStateOn ? "开启(待命)" : "未开启";
    // 一行短句, 与另外两格同款; 细节收进悬停提示, 不占版面
    $("statusLobbyVoice").textContent = lobbyStateOn ? "【当前为：" + (lobbyLocaleName || liveLocale || "已开启") + "】" : "【当前为：未开启】";
    const details = [
      "状态：" + (lobbyStateOn ? "开启" : "未开启"),
      lobbyActive ? (live.presence === "in" ? "正在选人, 实时播报中" : "监视中, 等待进入选人") : "监听未运行",
      "已播报 " + (live.played || 0) + " 条",
      clientVoice && clientVoice.supported ? "原版台词：" + (clientVoice.suppressed ? "已静音" : "开着") : clientRunning === false ? "原版台词：客户端未启动" : "",
      live.playback_failed ? "播放失败 " + live.playback_failed + " 次（" + ((live.last_playback && live.last_playback.error) || "未知") + "）" : "",
      lastAppliedText()
    ].filter(Boolean);
    $("cardStatusLobby").title = details.join("\n");

    // 界面不再放这些字, 但信息不丢: 上次开启记录写进日志, 失效时给一条提醒
    warnIfLastAppliedStale(ingame);
    const record = lastAppliedText();
    if (record && record !== lastAppliedLogged) {
      lastAppliedLogged = record;
      log(record + "（记录：本次启动未开启选人语音，需要点『开启语音包』）");
    }
  }

  async function refresh() {
    const [stateRes, localesRes, configRes] = await Promise.all([
      api("/api/state"),
      api("/api/locales?stats=1"),
      api("/api/config")
    ]);
    store.state = stateRes.state;
    store.locales = localesRes.locales || [];
    store.config = configRes.config;

    renderPathRow();
    if (!preferencesReady) restorePreferences(store.config, configRes.path);
    renderLocaleRow();
    renderStatusRow();
    setBusy(Boolean(Object.keys(store.state.busy || {}).length));
    lastApplied = (store.state && store.state.last_applied) || null;
    hideEnableTip = (store.state && store.state.hide_enable_tip) === true;
    releaseMode = (store.state && store.state.release) === true;
    // 后端要求(双击图标时): 让外壳把窗口亮出来, 免得用户以为软件没了
    if (store.state && store.state.window_show && window.ipc && typeof window.ipc.postMessage === "function") {
      try { window.ipc.postMessage("show"); } catch (error) { console.warn("恢复窗口失败", error); }
    }
    const logButton = $("btnOpenLog");
    if (logButton) logButton.classList.toggle("hidden", releaseMode);
    await loadClientVoice();
    await loadTextPack();
    // 状态刷新后同步监听器: 开启语音包(含选人语音)就启动, 还原就停止, 重启后自动恢复
    void syncLobbyLive();
  }

  /* ------------------------------------------------ 客户端界面文字(语言跟着语音包走) */

  /** 语音包代码 -> 文字包代码(en_US -> en_us); 选了没有文字包的语言就返回空。 */
  function textPackLocale() {
    const code = String(store.selected || "").toLowerCase();
    return ["en_us", "ja_jp", "ko_kr"].indexOf(code) >= 0 ? code : "";
  }

  let textPackState = null;

  /** 状态画在勾选项上: 已开启就勾上; 语音包语言没有对应文字包时禁用并说明原因。 */
  function renderTextPack(state) {
    if (state) textPackState = state;
    const box = $("modClientText");
    if (!box || !textPackState) return;
    const locale = textPackLocale();
    const supported = textPackState.supported || [];
    if (!locale || supported.indexOf(locale) < 0) {
      box.checked = false;
      box.disabled = true;
      box.title = "只有语音包选了英语 / 日语 / 韩语时, 才能替换客户端界面文字";
      const cardOff = $("cardStatusClientText");
      if (cardOff) cardOff.classList.remove("active");
      const tagOff = $("tagStatusClientText");
      if (tagOff) tagOff.textContent = "原版";
      const badgeOff = $("statusClientText");
      if (badgeOff) badgeOff.textContent = "未开启";
      return;
    }
    box.disabled = false;
    // 勾选是"这次要不要一起开"的选项, 由用户掌握; 真实状态看下面那张状态卡
    box.title = (textPackState.message || "") + " · 只改客户端界面文字，不动局内文字";
    const on = Boolean(textPackState.active && textPackState.staged === locale);

    // 状态卡(与另外三格同款): 开了就点亮, 并写清目标语言与是否需要重启客户端
    const names = { en_us: "英文", ja_jp: "日文", ko_kr: "韩文" };
    const card = $("cardStatusClientText");
    if (card) card.classList.toggle("active", on);
    const tag = $("tagStatusClientText");
    if (tag) tag.textContent = on ? "已开启" : "原版";
    const badge = $("statusClientText");
    if (badge) {
      if (!on) badge.textContent = "未开启";
      else badge.textContent = "【当前为：" + (names[locale] || locale) + "】" +
        (textPackState.clientRunning ? "（需重启客户端）" : "");
    }
  }

  async function callTextPack(action, locale) {
    const payload = await api("/api/textpack", { method: "POST", body: JSON.stringify({ action, locale }) });
    renderTextPack(payload.state);
    if (payload.message) log(payload.message);
    return payload;
  }

  async function loadTextPack() {
    try {
      renderTextPack((await api("/api/textpack")).state);
    } catch (error) {
      console.warn("读取客户端文字状态失败", error);
    }
  }

  /** 语音包换了语言时, 已开启的文字包跟着换过去(需要重启客户端才生效)。 */
  async function syncTextPackLocale() {
    if (!textPackState || !textPackState.active) return;
    const target = textPackLocale();
    if (!target || target === textPackState.staged) return;
    await callTextPack("stage", target);
  }

  /** 这次点"开启语音包"要不要一起开客户端界面文字(和另外三个勾选项一样, 只是个选项)。 */
  function clientTextSelected() {
    const box = $("modClientText");
    return Boolean(box && box.checked && !box.disabled);
  }

/* ------------------------------------------------ 任务执行 */

  async function waitTask(id) {
    setBusy(true);
    store.taskId = id;
    let status = "running";
    while (status === "running" || status === "pending") {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const payload = await api("/api/tasks/" + id);
      status = payload.task.status;
      if (status === "running") continue;

      const result = payload.result || {};
      for (const line of (result.summary && result.summary.lines) || []) {
        log("结果：" + line);
      }
      for (const item of result.results || []) {
        if (!item.ok && item.message) {
          log("失败原因：" + item.message.replace(/\n/g, " "));
        }
      }
      const msg = result.message || payload.task.error || (status === "succeeded" ? "操作完成" : "操作失败");
      log(msg);
      setStatus(msg, status === "succeeded" ? "ok" : "err", status === "succeeded" ? 100 : 0);
    }
    store.taskId = null;
    await refresh().catch(() => undefined);
    setBusy(false);
    return status;
  }

  async function startTask(label, request) {
    if (store.busy) {
      setStatus("已有任务正在执行，请稍候…", "err");
      return;
    }
    setBusy(true);
    log("=== " + label + " ===");
    setStatus("正在执行：" + label + "…", "", 0);
    try {
      // 渠道等参数通过配置传给后端；必须等写盘后再创建切换/还原任务。
      for (;;) {
        const pending = preferenceQueue;
        await pending;
        if (pending === preferenceQueue) break;
      }
      if (!preferencesReady || preferencesDirty) throw new Error("配置尚未保存成功，请先重试保存配置。");
      const payload = await request();
      return await waitTask(payload.task.id);
    } catch (error) {
      log("错误：" + error.message);
      setStatus("错误：" + error.message, "err", 0);
      setBusy(false);
      return "failed";
    }
  }

  /* ------------------------------------------------ 事件绑定 */

  // 第一排：自动搜索路径 + 确认路径 + 国服/外服自动识别与切换
  async function confirmPath(customPath, customSource) {
    const rawPath = (typeof customPath === "string" ? customPath : $("leaguePathInput").value).trim();
    $("leaguePathInput").value = rawPath;

    const immediateRegion = detectRegionFromPath(rawPath, customSource);
    if (immediateRegion) {
      setServerRegion(immediateRegion, false);
      preferenceRegion = immediateRegion;
    }

    try {
      setBusy(true);
      await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ leaguePath: rawPath })
      });
      await savePreferences();
      await refresh();
      const resolved = store.state && store.state.paths && store.state.paths.leagueDir;
      const sourceDetail = store.state && store.state.paths && store.state.paths.sourceDetail;
      const finalRegion = detectRegionFromPath(resolved || rawPath, sourceDetail || customSource);
      if (finalRegion) {
        setServerRegion(finalRegion, false);
        if (preferenceRegion !== finalRegion) {
          preferenceRegion = finalRegion;
          await savePreferences();
        }
      }
      if (resolved) {
        const regionLabel = store.region === "cn" ? "国服" : "外服";
        log("已确认游戏路径（" + regionLabel + "）：" + resolved);
        setStatus("路径已确认（" + regionLabel + "）：" + resolved, "ok", 100);
      } else {
        log("未能在该路径找到客户端，请检查路径是否正确");
        setStatus("未找到有效客户端目录，请检查输入路径", "err", 0);
      }
    } catch (error) {
      log("保存路径失败：" + error.message);
      setStatus("保存路径失败：" + error.message, "err", 0);
    } finally {
      setBusy(false);
    }
  }

  async function autoSearchPaths() {
    try {
      setBusy(true);
      setStatus("正在自动搜索电脑内的英雄联盟路径…", "");
      const payload = await api("/api/paths");
      const rawCandidates = payload.candidates || [];

      const seen = new Set();
      const unique = [];
      for (const item of rawCandidates) {
        const dir = (item.leagueDir || item.path || "").trim();
        if (!dir) continue;
        const key = dir.toLowerCase().replace(/[\\/]+$/, "");
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push({
          dir,
          source: item.sourceDetail || item.source || "自动探测",
          ready: Boolean(item.finalDir)
        });
      }

      if (unique.length === 0) {
        log("自动搜索未找到英雄联盟安装路径");
        setStatus("未搜索到英雄联盟路径，请手动输入", "err", 0);
        return;
      }

      if (unique.length === 1) {
        const chosen = unique[0];
        log("自动捕获到英雄联盟路径：" + chosen.dir);
        await confirmPath(chosen.dir, chosen.source);
        return;
      }

      log("检测到 " + unique.length + " 个英雄联盟路径，等待用户选择");
      setStatus("检测到多个英雄联盟路径，请在弹窗中选择一个", "");
      const listHost = $("pathCandidateList");
      listHost.innerHTML = "";
      for (const cand of unique) {
        const candRegion = detectRegionFromPath(cand.dir, cand.source);
        const regionTag = candRegion === "global" ? "外服" : "国服";
        const row = document.createElement("div");
        row.className = "path-cand-item";
        row.innerHTML =
          '<div class="path-cand-info">' +
          '<span class="path-cand-dir">' + escapeHtml(cand.dir) + "</span>" +
          '<span class="path-cand-meta">[' + regionTag + "] " +
          escapeHtml(cand.source) +
          (cand.ready ? " · 游戏资源目录已就绪" : "") +
          "</span>" +
          "</div>" +
          '<button type="button" class="btn tiny primary">选择</button>';
        row.onclick = () => {
          $("pathSelectModal").classList.add("hidden");
          void confirmPath(cand.dir, cand.source);
        };
        listHost.appendChild(row);
      }
      $("pathSelectModal").classList.remove("hidden");
    } catch (error) {
      log("自动搜索路径失败：" + error.message);
      setStatus("自动搜索失败：" + error.message, "err", 0);
    } finally {
      setBusy(false);
    }
  }

  $("btnAutoSearchPath").onclick = () => void autoSearchPaths();
  $("btnConfirmPath").onclick = () => void confirmPath();
  $("leaguePathInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") void confirmPath();
  });
  $("leaguePathInput").addEventListener("input", () => {
    const region = detectRegionFromPath($("leaguePathInput").value);
    if (region) {
      setServerRegion(region, true);
    }
  });

  /* ------------------------------------------------ 下载语音包 / 从路径导入 */

  async function copyToClipboard(text, label) {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard || !navigator.clipboard.writeText) {
        throw new Error("当前环境不支持剪贴板");
      }
      await navigator.clipboard.writeText(text);
      setStatus(label + "已复制", "ok", 2000);
    } catch {
      setStatus("复制失败，请手动选中输入框里的内容复制", "err", 3000);
    }
  }

  $("packDownloadLink").value = PACK_DOWNLOAD.url;
  $("packDownloadCode").value = PACK_DOWNLOAD.code;
  $("btnPackDownload").onclick = () => $("packDownloadModal").classList.remove("hidden");
  // 品牌图是个按钮: 点击打开品牌链接(链接未配置/被拦时不报错, 只记一条日志)
  $("btnBrand").onclick = async () => {
    if (!BRAND_LINK) {
      log("品牌链接还没配置(见 app.js 的 BRAND_LINK)");
      return;
    }
    // 外壳不处理"新窗口"请求, 直接 window.open 点了没反应; 交给后端用系统浏览器打开。
    try {
      const result = await api("/api/open-url", { method: "POST", body: JSON.stringify({ url: BRAND_LINK }) });
      if (result && result.ok) {
        log("已用系统浏览器打开：" + BRAND_LINK);
        return;
      }
      log((result && result.message) || "打开失败");
    } catch (error) {
      console.warn("走后端打开失败, 退回 window.open", error);
    }
    try {
      window.open(BRAND_LINK, "_blank", "noopener");
      log("已打开品牌链接：" + BRAND_LINK);
    } catch (error) {
      log("打开品牌链接失败：" + (error && error.message ? error.message : error) + " → " + BRAND_LINK);
    }
  };
  $("btnClosePackDownload").onclick = () => $("packDownloadModal").classList.add("hidden");
  $("btnCopyPackLink").onclick = () => void copyToClipboard(PACK_DOWNLOAD.url, "下载链接");
  $("btnCopyPackCode").onclick = () => void copyToClipboard(PACK_DOWNLOAD.code, "提取码");

  $("btnClosePathSelect").onclick = () => {
    $("pathSelectModal").classList.add("hidden");
  };
  $("pathSelectModal").addEventListener("click", (event) => {
    if (event.target === $("pathSelectModal")) {
      $("pathSelectModal").classList.add("hidden");
    }
  });

  // 国服 / 外服 按钮
  void loadRegionInfo();
  $("btnServerRegion").onclick = () => {
    const next = store.region === "cn" ? "global" : "cn";
    setServerRegion(next, true);
    preferenceRegion = next;
    void savePreferences();
    const label = store.region === "cn" ? "国服" : "外服";
    log("已手动切换区服模式为：" + label);
    setStatus("已切换为：" + label, "ok");
  };

  for (const id of Object.values(moduleControls)) {
    $(id).addEventListener("change", () => {
      void savePreferences();
      renderStatusRow();
      // 勾/取消"选人语音"会改变"客户端必须在运行"的判定; 但不会改变开关状态(那要点"开启语音包")
      applyDisabledStates();
    });
  }

  // 第二排：自定义下拉栏开关 & 压缩包文件选择
  $("selectTrigger").onclick = (event) => {
    event.stopPropagation();
    const wrap = $("customLocaleSelect");
    const isOpen = wrap.classList.toggle("open");
    $("selectMenu").classList.toggle("hidden", !isOpen);
    $("selectTrigger").setAttribute("aria-expanded", String(isOpen));
  };

  document.addEventListener("click", (event) => {
    if (!$("customLocaleSelect").contains(event.target)) {
      closeCustomDropdown();
    }
  });

  $("btnChooseLocale").onclick = () => {
    const fileInput = $("voicePackFileInput");
    fileInput.value = "";
    fileInput.click();
  };

  $("voicePackFileInput").onchange = (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    void importVoicePack(file);
  };

  /**
   * 导入语音包压缩包：把文件内容直接传给后端，
   * 由后端解压 -> 识别语种 -> 装进资源目录；装完会出现在下拉栏，这里顺手选中它。
   */
  async function importVoicePack(file) {
    if (store.busy) {
      setStatus("已有任务正在执行，请稍候…", "err");
      return;
    }
    const fileName = file.name;
    log("已选择语音包压缩包：" + fileName);
    setStatus("正在上传语音包：" + fileName + "…", "", 3);
    setBusy(true);
    try {
      const response = await fetch(
        "/api/packs/import?name=" + encodeURIComponent(fileName),
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file
        }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok === false) {
        throw new Error((payload && payload.message) || "HTTP " + response.status);
      }

      const status = await waitTask(payload.task.id);
      if (status !== "succeeded") return;

      const detail = await api("/api/tasks/" + payload.task.id);
      const result = detail.result || {};
      const code = result.code || "";
      await refresh();
      if (code) {
        selectLocaleValue(code, true);
        setStatus("已导入并选中：" + (result.name || code), "ok", 100);
      } else {
        setStatus("导入完成，请在下拉栏中选择语音包", "ok", 100);
      }
    } catch (error) {
      log("导入失败：" + error.message);
      setStatus("导入失败：" + error.message, "err", 0);
    } finally {
      setBusy(false);
      $("voicePackFileInput").value = "";
    }
  }

  // 第四排：恢复原版 & 开启语音包
  /** 真正执行开启(提示确认过之后再走这里)。 */
  function enableVoicePack(locale, modules, label) {
    void startTask("开启语音包：" + label, () =>
      api("/api/apply", {
        method: "POST",
        // restartClient: 客户端正在运行时, 切换完自动帮用户重启一次(客户端占着文件句柄, 重启后才生效)。
        // 后端只会在"客户端在运行 + 勾了需要重启的项"时才真的重启, 纯选人语音不会重启。
        // clientText: 勾了"客户端界面文字"就一起装注入器(需要一次授权), 后端会先装好再重启客户端
        body: JSON.stringify({ locale, modules, restartClient: true, clientText: clientTextSelected() })
      })
    ).then((result) => {
      // 只有真的成功了才算"本次会话已开启选人语音"
      if (result === "failed" || (result && result.ok === false)) return;
      lobbyVoiceSessionOn = modules.includes("lobby_voice");
      void refresh();
    });
  }

  /** 提示弹窗里等待确认的那次开启。 */
  let pendingEnable = null;

  function closeEnableTip() {
    $("enableTipModal").classList.add("hidden");
    pendingEnable = null;
  }

  // 关闭(×)= 取消这次开启
  $("btnCloseEnableTip").onclick = closeEnableTip;

  // 不再提醒 = 记住设置 + 继续开启
  $("btnEnableTipNever").onclick = () => {
    const pending = pendingEnable;
    closeEnableTip();
    hideEnableTip = true;
    void api("/api/ui/hide-enable-tip", { method: "POST", body: "{}" }).catch((error) =>
      log("保存『不再提醒』失败：" + (error && error.message ? error.message : error), "warn")
    );
    if (pending) enableVoicePack(pending.locale, pending.modules, pending.label);
  };

  // 确定 = 直接开启
  $("btnEnableTipOk").onclick = () => {
    const pending = pendingEnable;
    closeEnableTip();
    if (pending) enableVoicePack(pending.locale, pending.modules, pending.label);
  };

  $("btnApply").onclick = () => {
    const locale = store.selected;
    if (!locale) {
      setStatus("请先在第二排下拉栏中选择语音包", "err");
      $("selectTrigger").click();
      return;
    }
    const modules = selectedModules();
    if (!modules.length) {
      setStatus("请至少勾选一项要切换的内容", "err");
      return;
    }
    const found = allLocaleItems().find((item) => item.code === locale);
    const label = found ? found.name : locale;
    // 没点过「不再提醒」时, 先弹一次提示(里面有关闭 / 不再提醒 / 确定)
    if (!hideEnableTip) {
      pendingEnable = { locale, modules, label };
      $("enableTipModal").classList.remove("hidden");
      return;
    }
    enableVoicePack(locale, modules, label);
  };

  $("btnRestore").onclick = () => {
    const modules = selectedModules();
    const targetModules = modules.length
      ? modules
      : ["ingame_voice", "ingame_lang", "lobby_voice"];
    void startTask("恢复游戏原版", () =>
      api("/api/restore", {
        method: "POST",
        body: JSON.stringify({ modules: targetModules })
      })
    ).then((result) => {
      if (result === "failed" || (result && result.ok === false)) return;
      lobbyVoiceSessionOn = false;
      void refresh();
    });
  };

  // 第五排：日志弹窗
  $("btnOpenLog").onclick = () => {
    $("logModal").classList.remove("hidden");
  };
  $("btnCloseLog").onclick = () => {
    $("logModal").classList.add("hidden");
  };
  $("btnClearLog").onclick = () => {
    store.logs = [];
    $("logBox").textContent = "[就绪]";
  };
  $("logModal").addEventListener("click", (event) => {
    if (event.target === $("logModal")) {
      $("logModal").classList.add("hidden");
    }
  });

  /* ------------------------------------------------ SSE 实时推送 */

  function connectEvents() {
    const events = new EventSource("/api/events");
    events.addEventListener("progress", (event) => {
      const data = JSON.parse(event.data);
      const progress = data.progress;
      setStatus(
        "正在处理 " + progress.percent + "% (" + progress.done + "/" + progress.total + ") " + (progress.current || ""),
        "",
        progress.percent
      );
    });
    events.addEventListener("log", (event) => {
      log(JSON.parse(event.data).line);
    });
    events.addEventListener("done", (event) => {
      const data = JSON.parse(event.data);
      if (data.status === "succeeded") {
        setStatus("操作已完成", "ok", 100);
      }
    });
    // 选人台词: 后端监听到悬停/锁定/禁用后推过来, 这里用 <audio> 播语音包里的音频
    events.addEventListener("lobby", (event) => {
      try {
        playLobbyVoice(JSON.parse(event.data));
      } catch (error) {
        // 以前这里静默吞掉, 出错时完全查不到 —— 现在写进日志框
        log("选人事件处理失败：" + (error && error.message ? error.message : error), "warn");
      }
    });
    // 客户端音量变了: 立刻把播报音量对齐过去(后端每 5 秒检查一次客户端设置并推送)
    events.addEventListener("voice-volume", (event) => {
      try {
        const data = JSON.parse(event.data);
        const next = Number(data.volume);
        if (next > 0) {
          setVolume(next, false);
          log("客户端音量变化，播报音量已对齐：" + next + "%");
          reportPlayback(true, "", "volume:" + next);
        }
      } catch {
        /* ignore */
      }
    });
    events.onerror = () => {
      setStatus("后端服务连接已断开", "err");
    };
  }

  /* ------------------------------------------------ 选人语音实时播报 */

  // 播放端就是本窗口: Chromium 原生支持 ogg/vorbis, 不需要任何解码依赖
  const lobbyAudio = new Audio();
  lobbyAudio.preload = "auto";
  let lobbyLiveLocale = "";
  let lastVoice = { kind: "choose", championId: 0 };

  /* --------------------------------- 播报音量 / 延迟(不显示在界面上)

     播报音量**不需要用户设置**: 选人语音开启时自动抓客户端的总音量来对齐
     (监听期间每 30 秒复查一次, 用户在客户端改了音量也能跟上)。
     延迟固定在 config.json -> ui.voiceDelayMs(默认 1000ms)。
     客户端原版台词的自动静音闭环由后端默认开启, 可用 POST /api/client-voice {"auto":false} 关掉。
  */

  const VOLUME_KEY = "leagueVoice.volume";
  const FOLLOW_KEY = "leagueVoice.followClient";

  function legacyPreference(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  const legacyVolume = legacyPreference(VOLUME_KEY);
  let volume = legacyVolume === null ? 60 : Number(legacyVolume);
  if (!Number.isFinite(volume)) volume = 60;
  volume = Math.max(0, Math.min(100, Math.round(volume)));
  let volumeBeforeMute = volume > 0 ? volume : 60;
  // 是否跟随客户端音量(总音量 × 音效), 默认开启; 手动拖过滑杆就自动关掉
  let followClient = legacyPreference(FOLLOW_KEY) !== "0";
  // 播报固定延迟(毫秒): 实测 1000ms 最贴合官方台词的节奏, 作为固定默认值
  let voiceDelayMs = 1000;
  let pendingPlayTimer = null;

  function setVoiceDelay(ms, persist) {
    const value = Math.max(0, Math.min(3000, Math.round(Number(ms) || 0)));
    voiceDelayMs = value;
    const input = $("delayInput");
    if (input) input.value = String(value);
    if (persist) void savePreferences();
  }

  function applyDelayInput() {
    const input = $("delayInput");
    if (input) input.value = String(voiceDelayMs);
  }

  function applyFollowLabel() {
    const button = $("btnAlignVolume");
    if (!button) return;
    button.dataset.on = followClient ? "true" : "false";
    button.title = followClient
      ? "已开启：播报音量跟随客户端音量（点一下改为手动）"
      : "手动音量（点一下改为跟随客户端音量）";
  }

  function applyVolume() {
    lobbyAudio.volume = Math.max(0, Math.min(1, volume / 100));
    const slider = $("volumeSlider");
    if (slider) slider.value = String(volume);
    const label = $("volumeValue");
    if (label) label.textContent = volume + "%";
    const icon = $("btnMuteToggle");
    if (icon) icon.dataset.muted = volume === 0 ? "true" : "false";
  }

  function setVolume(next, persist) {
    volume = Math.max(0, Math.min(100, Math.round(next)));
    if (volume > 0) volumeBeforeMute = volume;
    if (persist) void savePreferences();
    applyVolume();
  }


  /* 客户端原版台词开关(关掉客户端自己念的原版台词, 保留音效与音乐) */
  let clientVoice = { supported: false, suppressed: false, message: "" };
  let clientVoiceRetry = null;

  function applyClientVoiceLabel() {
    const button = $("btnClientVoice");
    if (!button) return;
    if (!clientVoice.supported && !clientVoice.suppressed) {
      // 客户端没启动 / 读不到设置: 明确禁用, 不做无效操作
      button.textContent = "原版台词：客户端未启动";
      button.dataset.mode = "off";
      button.disabled = true;
      button.title = clientVoice.message || "英雄联盟没在运行，读不到也改不了它的设置；客户端启动后这个按钮会自动可用。";
      return;
    }
    button.disabled = false;
    button.dataset.mode = clientVoice.auto ? "on" : "off";
    if (!clientVoice.auto) {
      button.textContent = "原版台词：不自动";
      button.title = "已关闭自动静音：客户端会照常念原版台词。点一下开启自动闭环。";
      return;
    }
    button.textContent = clientVoice.suppressed ? "原版台词：自动静音中" : "原版台词：自动";
    button.title = clientVoice.suppressed
      ? "选人期间已自动关闭客户端原版台词（音效与音乐不受影响），选人结束后会自动打开。点一下关闭这套自动逻辑。"
      : "已开启自动闭环：启动选人语音时自动静音客户端原版台词，选人结束自动打开。";
  }

  async function loadClientVoice() {
    try {
      const data = await api("/api/client-voice");
      clientVoice = {
        supported: Boolean(data.supported),
        suppressed: Boolean(data.suppressed),
        auto: data.auto !== false,
        aligned: Number(data.aligned_volume) || 0,
        volumes: data.volumes || null,
        message: data.message || ""
      };
      clientRunning = data.client_running !== false;
    } catch {
      clientVoice = { supported: false, suppressed: false, auto: true, aligned: 0, volumes: null, message: "读取失败" };
      clientRunning = false;
    }
    applyClientVoiceLabel();
    applyDisabledStates();
    // 客户端可能稍后才启动: 没读到就每 10 秒重试, 起来后按钮自动可用、自动接管
    if (clientRunning === false) {
      if (!clientVoiceRetry) {
        clientVoiceRetry = setTimeout(() => {
          clientVoiceRetry = null;
          void loadClientVoice();
        }, 10000);
      }
    } else if (clientVoiceRetry) {
      clearTimeout(clientVoiceRetry);
      clientVoiceRetry = null;
    }
    // 播报音量 = 客户端 总音量 × 音效音量(后端 computeAlignedVolume 算好)
    if (lobbyVoiceStateOn() && clientVoice.aligned > 0 && clientVoice.aligned !== volume) {
      setVolume(clientVoice.aligned, false);
      const volumes = clientVoice.volumes || {};
      log(
        "播报音量已对齐客户端：" + clientVoice.aligned + "%" +
          "（客户端 总音量 " + (volumes.master ?? "?") + "% × 音效 " + (volumes.voice ?? volumes.sfx ?? "?") + "%）"
      );
    }
    applyFollowLabel();
  }

  function initHud() {
    applyVolume();
    applyClientVoiceLabel();
    const clientVoiceButton = $("btnClientVoice");
    if (clientVoiceButton) {
      clientVoiceButton.addEventListener("click", async () => {
        if (clientRunning === false) {
          setStatus("英雄联盟未启动：读不到也改不了它的设置，客户端启动后会自动接管", "warn", 4000);
          log("英雄联盟未启动：原版台词开关需要客户端在运行");
          return;
        }
        // 这个按钮切换"选人期间自动静音"这套闭环
        const next = !clientVoice.auto;
        clientVoiceButton.disabled = true;
        try {
          const data = await api("/api/client-voice", { method: "POST", body: JSON.stringify({ auto: next }) });
          clientVoice = {
            supported: Boolean(data.supported),
            suppressed: Boolean(data.suppressed),
            auto: data.auto !== false,
            aligned: Number(data.aligned_volume) || 0,
            volumes: data.volumes || null,
            message: data.message || ""
          };
          log(data.message || (next ? "已开启自动静音" : "已关闭自动静音"));
        } catch (error) {
          log("切换客户端原版台词失败：" + (error && error.message ? error.message : error), "warn");
        } finally {
          clientVoiceButton.disabled = false;
          applyClientVoiceLabel();
        }
      });
    }
    const slider = $("volumeSlider");
    if (slider) {
      slider.addEventListener("input", () => {
        // 手动拖过滑杆就不再让客户端音量覆盖
        if (followClient) {
          followClient = false;
          applyFollowLabel();
        }
        setVolume(Number(slider.value), true);
      });
    }
    applyDelayInput();
    const delay = $("delayInput");
    if (delay) {
      delay.addEventListener("change", () => {
        setVoiceDelay(delay.value, true);
        log("播报延迟设为 " + voiceDelayMs + "ms");
      });
    }
    const align = $("btnAlignVolume");
    if (align) {
      align.addEventListener("click", () => {
        followClient = !followClient;
        void savePreferences();
        applyFollowLabel();
        if (followClient) {
          void loadClientVoice();
        } else {
          log("已改为手动音量");
        }
      });
    }
    const mute = $("btnMuteToggle");
    if (mute) {
      mute.addEventListener("click", () => setVolume(volume === 0 ? volumeBeforeMute : 0, true));
    }
  }

  /** 把播放结果回报给后端(排障: 能直接看到浏览器给的错误原因)。 */
  function reportPlayback(ok, error, detail) {
    try {
      fetch("/api/lobby-live/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ok,
          error: error || "",
          detail: detail || "",
          kind: lastVoice.kind,
          championId: lastVoice.championId,
          volume
        })
      }).catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  lobbyAudio.addEventListener("playing", () => {
    reportPlayback(true, "", "playing");
  });
  lobbyAudio.addEventListener("error", () => {
    const code = lobbyAudio.error ? lobbyAudio.error.code : 0;
    const message = lobbyAudio.error ? String(lobbyAudio.error.message || "") : "";
    reportPlayback(false, "media_error_" + code, message);
    setStatus("播报音频加载失败（code " + code + " " + message + "）", "warn", 0);
  });

  let lastPlayKey = "";
  let lastPlayAt = 0;

  // 兜底轮询用: 最近处理过的事件时间戳(SSE 万一不通, 也能靠它播放)
  let lastEventAt = 0;

  function playLobbyVoice(data) {
    if (!data || !data.url) return;
    if (Number(data.at) > lastEventAt) lastEventAt = Number(data.at);
    // 双保险: 同一句台词短时间重复推送时忽略(否则第二遍会把第一遍打断, 声音反而迟迟不出来)
    const key = data.kind + ":" + data.championId;
    const now = Date.now();
    if (key === lastPlayKey && now - lastPlayAt < 1500) {
      log("忽略重复推送：" + key);
      return;
    }
    lastPlayKey = key;
    lastPlayAt = now;
    lastVoice = { kind: data.kind, championId: data.championId };
    // 播报前现取一次客户端音量: 否则刚调完音量就锁定英雄, 这一句会用上一个音量(实测体感就是"偏大")
    void loadClientVoice();
    // 固定延迟: 等官方那句先起头, 避免两路叠在一起或我们抢在前面
    if (pendingPlayTimer) {
      clearTimeout(pendingPlayTimer);
      pendingPlayTimer = null;
    }
    if (voiceDelayMs > 0) {
      pendingPlayTimer = setTimeout(() => {
        pendingPlayTimer = null;
        startPlayback(data.url);
      }, voiceDelayMs);
    } else {
      startPlayback(data.url);
    }
    if (data.championId) {
      log("播放选人台词：" + data.kind + " 英雄 " + data.championId + "（" + data.phase + "）" + (voiceDelayMs > 0 ? "，延迟 " + voiceDelayMs + "ms" : ""));
    }
  }

  /** 真正开始播放(换英雄时立刻切掉上一条, 避免两条台词叠在一起)。 */
  function startPlayback(url) {
    try {
      lobbyAudio.pause();
      lobbyAudio.currentTime = 0;
    } catch {
      /* ignore */
    }
    lobbyAudio.src = url;
    const played = lobbyAudio.play();
    if (played && typeof played.catch === "function") {
      played.catch((error) => {
        reportPlayback(false, "play_" + (error && error.name ? error.name : "error"), error && error.message ? error.message : "");
        setStatus("浏览器拦下了自动播放，点一下窗口任意位置即可", "warn", 0);
      });
    }
  }

  // 首次交互时解锁音频(浏览器自动播放策略); 用 pointerdown 比 click 更早
  const unlockAudio = () => {
    try {
      lobbyAudio.muted = true;
      const started = lobbyAudio.play();
      if (started && typeof started.then === "function") {
        started.then(() => {
          lobbyAudio.pause();
          lobbyAudio.muted = false;
        }).catch(() => {
          lobbyAudio.muted = false;
        });
      }
    } catch {
      /* ignore */
    }
  };
  document.addEventListener("pointerdown", unlockAudio, { once: true });
  document.addEventListener("click", unlockAudio, { once: true });

  /**
   * 选人语音的开关: **本次会话**点过"开启语音包"(且含选人语音)才开启。
   *
   *   - 勾选"选人语音" + 点"开启语音包" -> 本次会话开启 -> 这里启动监听
   *   - 点"恢复原版" -> 关闭 -> 这里停止监听
   *   - 关掉软件再打开 -> 状态清零(**不会自己开起来**), 需要重新点一次"开启语音包"
   * 勾选框/下拉栏只是"这次开启要用的参数"。config.json 里的 ui.lastApplied 只作为
   * "上次开启"的记录显示(日志/悬停), 不再用来自动开启 —— 用户明确要求退出即结束。
   */
  async function syncLobbyLive() {
    // 串行化: 并发调用会各自越过下面的判断, 结果起两个监听器(换语种时实测出现过)
    syncQueue = syncQueue.then(() => doSyncLobbyLive()).catch(() => undefined);
    return syncQueue;
  }

  async function doSyncLobbyLive() {
    if (!preferencesReady) return;
    // 任务执行中(比如"一键开启"后端正在启动监听)先不动它, 否则会出现 停->启 的无谓抖动
    if (store.busy) return;
    const modules = (lastApplied && lastApplied.modules) || [];
    const wanted =
      lobbyVoiceSessionOn && lastApplied && lastApplied.locale && modules.includes("lobby_voice")
        ? lastApplied.locale
        : "";
    if (!wanted) {
      await stopLobbyLive();
      return;
    }
    if (wanted === lobbyLiveLocale) return;
    // 换语种**不先停**: 后端会原地换语音包(停了会先还原客户端设置再重新静音, 用户看到"设置里没关上")
    const switchedLocale = lobbyLiveLocale;
    lobbyLiveLocale = wanted;
    try {
      const response = await fetch("/api/lobby-live/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: wanted })
      });
      const data = await response.json();
      if (data && data.ok) {
        log(
          switchedLocale
            ? switchedLocale + " -> " + wanted + "：语音包已切换（" + data.message + "）"
            : "选人语音监听已启动（状态：开启）：" + data.message
        );
        renderStatusRow();
        // 启动瞬间: 后端按闭环静音客户端原版台词, 同时抓客户端音量对齐播报音量
        void loadClientVoice();
      } else if (data) {
        lobbyLiveLocale = "";
        log("选人语音监听未启动：" + (data.message || ""));
      }
    } catch (error) {
      lobbyLiveLocale = "";
      log("选人语音监听启动失败：" + error.message);
    }
  }

  /** 显式停止监听(用户主动选"未选中语音包"时)。 */
  async function stopLobbyLive() {
    if (!lobbyLiveLocale) return;
    lobbyLiveLocale = "";
    try {
      await fetch("/api/lobby-live/stop", { method: "POST" });
      log("选人语音监听已停止");
      // 关闭时后端会还原原版台词, 同步界面
      void loadClientVoice();
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------------------------ 启动初始化 */

  try {
    if (window.outerWidth > 860 || window.outerHeight > 660) {
      window.resizeTo(800, 600);
    }
  } catch {
    /* ignore */
  }

  // 排障用: 控制台里执行 __playVoice("choose", 266) 可手动触发一次播放, 排除"事件没来"的干扰
  window.__playVoice = (kind, championId) => {
    playLobbyVoice({ kind: kind || "choose", championId: Number(championId) || 0, phase: "test", url: "/api/lobby-audio/" + (kind || "choose") + "/" + championId + ".ogg?locale=" + (store.selected || "ja_JP") });
  };

  initHud();
  // 兜底: 每 2 秒问一次后端"最近有没有选人事件"。SSE 正常时这里什么也不会做(时间戳已被 SSE 更新),
  // SSE 断了就由它把台词播出来 —— 保证"听得见"不依赖单一通道
  // 每 30 秒重新对齐一次客户端音量(用户中途改了客户端音量也能跟上)
  setInterval(() => {
    if (!lobbyLiveLocale) return;
    void loadClientVoice();
  }, 30000);
  setInterval(() => {
    if (!lobbyLiveLocale) return;
    // SSE 连着的时候这条兜底没有任何用(时间戳已被 SSE 更新), 直接跳过,
    // 省掉每 2 秒一次的多余请求; 只有 SSE 断了才真的去问后端。
    if (events && events.readyState === 1) return;
    void (async () => {
      try {
        const data = await request("/api/lobby-live/state");
        const event = data && data.last_event;
        if (event && Number(event.at) > lastEventAt) {
          log("通过兜底轮询拿到选人事件（SSE 可能没送到）");
          playLobbyVoice(event);
        }
      } catch {
        /* ignore */
      }
    })();
  }, 2000);
  setBusy(false);
  refresh()
    .then(() => {
      void syncLobbyLive();
      log("已连接后端服务 v" + store.state.app.version);
      setStatus("就绪", "ok", 0);
    })
    .catch((error) => {
      setStatus("无法连接后端服务：" + error.message, "err", 0);
      log("无法连接后端：" + error.message);
    });
  connectEvents();
})();

/**
 * 原生外壳(wry)会给页面注入 window.ipc; 有它才说明我们在无边框窗口里,
 * 这时才显示自绘标题栏, 并把三个键接到外壳上。
 * (网页本身没有最小化/关闭窗口的权限, 所以必须由外壳执行)
 */
function setupAppTitlebar() {
  const ipc = window.ipc;
  if (!ipc || typeof ipc.postMessage !== "function") return;
  const bar = document.getElementById("appTitlebar");
  if (!bar) return;
  bar.hidden = false;
  const send = (message) => {
    try { ipc.postMessage(message); } catch (error) { console.warn("窗口操作失败", error); }
  };
  document.getElementById("winMin").addEventListener("click", () => send("minimize"));
  document.getElementById("winTray").addEventListener("click", () => send("tray"));
  document.getElementById("winClose").addEventListener("click", () => send("close"));
  bar.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.target.closest(".win-btn")) return;
    send("drag");
  });
  bar.addEventListener("dblclick", (event) => {
    if (!event.target.closest(".win-btn")) send("toggle-maximize");
  });
}
setupAppTitlebar();
