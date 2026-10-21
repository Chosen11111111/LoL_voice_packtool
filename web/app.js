/* 英雄联盟语音包切换器 —— 五排精致蓝白毛玻璃界面逻辑 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MAX_LOG = 500;

  /** 品牌图点开的链接(要换只改这一处)。 */
  const BRAND_LINK = "https://chosen1.lol";

  /** 语音包网盘下载信息(要换下载地址只改这一处)。 */
  const PACK_DOWNLOAD = {
    url: "https://pan.quark.cn/s/faa460d28263",
    code: "U3Dw"
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
    if (ui.region === "cn" || ui.region === "global") {
      preferenceRegion = ui.region;
      setServerRegion(ui.region, true);
    }
    preferencesReady = true;
    $("configSaveStatus").title = "配置文件：" + file;
    $("configSaveStatus").textContent = "配置已读取";
    if (ui.selectedLocale == null) void savePreferences();
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
    // 全站统一两个词: 没开是"原版", 开了是"已开启"; 细节都收进悬停提示
    $("tagStatusVoice").textContent = voiceActive ? "已开启" : "原版";
    $("statusIngameVoice").textContent = voiceActive ? "已开启" : "原版";
    $("cardStatusVoice").title = cleanStatusDetail(ingame.voice, voiceActive, ingame.active_locale) || "";

    // 2. 游戏内文字
    const langActive = Boolean(ingame.is_lang_active);
    $("cardStatusLang").classList.toggle("active", langActive);
    $("tagStatusLang").textContent = langActive ? "已开启" : "原版";
    $("statusIngameLang").textContent = langActive ? "已开启" : "原版";
    $("cardStatusLang").title = cleanStatusDetail(ingame.lang, langActive, ingame.active_locale) || "";

    // 3. 对局前选人语音: 由加载器插件在客户端里替换音频, 状态以插件开关为准
    const live = store.state.lobby || {};
    const lobbyActive = Boolean(live.enabled);
    const liveLocale = live.locale || lobby.locale || "";
    const lobbyLocaleObj = store.locales.find((item) => item.code === liveLocale);
    const lobbyLocaleName = lobbyLocaleObj ? lobbyLocaleObj.name : liveLocale;
    $("cardStatusLobby").classList.toggle("active", lobbyActive);
    // 这一格的口径是"状态": 上次开启时勾了选人语音, 状态就是开启
    const lobbyStateOn = Boolean(lastApplied && (lastApplied.modules || []).includes("lobby_voice"));
    $("tagStatusLobby").textContent = lobbyStateOn ? "已开启" : "原版";
    $("statusLobbyVoice").textContent = lobbyStateOn ? "已开启" : "原版";
    const lobbyShort = lobbyStateOn ? "【当前为：" + (lobbyLocaleName || liveLocale || "已开启") + "】" : "未开启";
    // 状态词统一成"原版 / 已开启"两个, 这句细节挂到下面的悬停提示里
    if (lobbyShort) $("cardStatusLobby").title = lobbyShort;
    const details = [
      "状态：" + (lobbyStateOn ? "开启" : "未开启"),
      lobbyActive ? "客户端内替换（" + (lobbyLocaleName || liveLocale) + "，共 " + (live.available || 0) + " 条台词）" : "未开启",
      lobbyActive
        ? (live.trace && live.trace.hits > 0
            ? "已拦截 " + live.trace.hits + " 次客户端请求（说明插件在客户端里生效了）"
            : "插件还没被客户端加载过 —— 重启客户端后才会生效")
        : "",
      live.legacy_wad_patch ? "检测到旧资源包补丁, 还原即可回滚" : "",
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
    await loadTextPack();
  }

  /* ------------------------------------------------ 客户端界面文字(语言跟着语音包走) */

  /**
   * 客户端界面文字用哪种语言: 优先跟着选中的语音包走;
   * 没选语音包(或选的语言没有文字包)时默认英文 —— 这样它可以单独开启, 不必先选语音包。
   */
  function textPackLocale() {
    const code = String(store.selected || "").toLowerCase();
    return ["en_us", "ja_jp", "ko_kr"].indexOf(code) >= 0 ? code : "en_us";
  }

  let textPackState = null;
  /** 只在第一次读到状态时, 用真实状态初始化第四项的勾选; 之后不再覆盖用户的选择。 */
  let textPackInitialized = false;

  /** 状态画在勾选项上: 已开启就勾上; 语音包语言没有对应文字包时禁用并说明原因。 */
  function renderTextPack(state) {
    if (state) textPackState = state;
    const box = $("modClientText");
    if (!box || !textPackState) return;
    const locale = textPackLocale();
    const supported = (textPackState && textPackState.supported) || [];
    if (supported.length && supported.indexOf(locale) < 0) {
      box.checked = false;
      box.disabled = true;
      box.title = "没有这个语言的文字包";
      return;
    }
    box.disabled = false;
    // 勾选是"这次要不要一起开"的选项, 由用户掌握; 真实状态看下面那张状态卡。
    // 但软件刚启动时要跟真实状态对齐一次(否则明明是开启的, 界面上却是没勾)。
    if (!textPackInitialized) {
      textPackInitialized = true;
      box.checked = Boolean(textPackState.active);
    }
    box.title = (textPackState.message || "") + " · 目标语言：" + ({ en_us: "英文", ja_jp: "日文", ko_kr: "韩文" }[locale] || locale) +
      " · 只改客户端界面文字，不动局内文字";
    const on = Boolean(textPackState.active && textPackState.staged === locale);

    // 状态卡(与另外三格同款): 开了就点亮, 并写清目标语言与是否需要重启客户端
    const names = { en_us: "英文", ja_jp: "日文", ko_kr: "韩文" };
    const card = $("cardStatusClientText");
    if (card) card.classList.toggle("active", on);
    const tag = $("tagStatusClientText");
    if (tag) tag.textContent = on ? "已开启" : "原版";
    const badge = $("statusClientText");
    if (badge) badge.textContent = on ? "已开启" : "原版";
    const cardEl = $("cardStatusClientText");
    if (cardEl) {
      cardEl.title = (textPackState.message || "") + (on
        ? "目标语言：" + (names[locale] || locale) + (textPackState.clientRunning ? "（客户端正在运行，需重启后生效）" : "")
        : "未开启，客户端界面为原版");
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
        body: JSON.stringify({ locale, modules, restartClient: true, clientText: clientTextSelected(), clientTextLocale: textPackLocale() })
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
    const modules = selectedModules();
    // 客户端界面文字可以单独开: 只勾它一项时不要求选语音包(文字包默认英文)
    const clientText = clientTextSelected();
    if (!locale && !clientText) {
      setStatus("请先在第二排下拉栏中选择语音包", "err");
      $("selectTrigger").click();
      return;
    }
    if (!modules.length && !clientText) {
      setStatus("请至少勾选一项要切换的内容", "err");
      return;
    }
    const found = allLocaleItems().find((item) => item.code === locale);
    const label = found ? found.name : clientText ? "仅客户端界面文字" : locale;
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
    events.onerror = () => {
      setStatus("后端服务连接已断开", "err");
    };
  }

  /* ------------------------------------------------ 启动初始化 */

  try {
    if (window.outerWidth > 860 || window.outerHeight > 660) {
      window.resizeTo(800, 600);
    }
  } catch {
    /* ignore */
  }

  setBusy(false);
  refresh()
    .then(() => {
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
