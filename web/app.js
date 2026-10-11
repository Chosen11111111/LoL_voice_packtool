/* 英雄联盟语音包切换器 —— 五排精致蓝白毛玻璃界面逻辑 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MAX_LOG = 500;

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

  let preferencesReady = false;
  let preferencesDirty = false;
  let preferenceRevision = 0;
  let preferenceQueue = Promise.resolve();
  let preferenceRegion = "auto";
  let pageClosing = false;
  const moduleControls = { ingame_voice: "modIngameVoice", ingame_lang: "modIngameLang", lobby_voice: "modLobbyVoice" };

  function preferenceSnapshot() {
    return { selectedLocale: store.selected, modules: selectedModules(), volume, followClient, voiceDelayMs, region: preferenceRegion };
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
    if (!isActive) return "国服原版文件";
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
    void syncLobbyLive();
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
      void stopLobbyLive();
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

  /** 显示"上次开启"的记录: 重启后仍能看出当前生效的是什么, 并与磁盘真实状态对照给出提醒。 */
  function renderLastApplied(ingame) {
    const box = $("statusLastApplied");
    if (!box) return;
    if (!lastApplied || !lastApplied.locale) {
      box.classList.add("hidden");
      box.textContent = "";
      return;
    }
    const localeName = (store.locales.find((item) => item.code === lastApplied.locale) || {}).name || lastApplied.locale;
    const modules = (lastApplied.modules || []).map((item) => MODULE_NAMES[item] || item).join(" + ") || "（未记录模块）";
    const when = lastApplied.at ? new Date(lastApplied.at) : null;
    const stamp = when && !Number.isNaN(when.getTime())
      ? (when.getMonth() + 1) + "-" + when.getDate() + " " + String(when.getHours()).padStart(2, "0") + ":" + String(when.getMinutes()).padStart(2, "0")
      : "";
    // 记录里含对局模块, 但磁盘上已是原版 -> 说明被还原过(或客户端更新覆盖了)
    const ingameInRecord = (lastApplied.modules || []).some((item) => item === "ingame_voice" || item === "ingame_lang");
    const stale = ingameInRecord && !ingame.is_voice_active && !ingame.is_lang_active;
    box.classList.remove("hidden");
    box.classList.toggle("warn", stale);
    box.textContent = stale
      ? "上次开启：" + localeName + "（" + modules + "）" + (stamp ? "· " + stamp : "") + " —— 对局文件现在是原版，可能已被还原或客户端更新覆盖，需要重新点『开启语音包』"
      : "上次开启：" + localeName + "（" + modules + "）" + (stamp ? "· " + stamp : "") + (ingameInRecord ? "" : " —— 选人语音已自动接管");
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
    renderLastApplied(ingame);

    $("cardStatusLobby").classList.toggle("active", lobbyActive);
    $("tagStatusLobby").textContent = lobbyActive ? "实时播报" : "未开启";
    const playbackNote = live.playback_failed
      ? "｜播放失败 " + live.playback_failed + " 次：" + ((live.last_playback && live.last_playback.error) || "未知")
      : live.playback_ok
        ? "｜已播放 " + live.playback_ok + " 次"
        : "";
    const clientNote = clientVoice && clientVoice.supported
      ? "｜原版台词：" + (clientVoice.suppressed ? "已静音" : "开着")
      : clientRunning === false
        ? "｜原版台词：客户端未启动"
        : "";
    $("statusLobbyVoice").textContent = lobbyActive
      ? "【监听中：" + (lobbyLocaleName || "默认语种") + "】" +
        (live.presence === "in" ? "选人进行中" : "等待进入选人") + "｜已播报 " + live.played + " 条" + playbackNote + clientNote
      : $("modLobbyVoice").checked ? "未开启（选择语音包后开始监听）" : "未开启（未勾选选人语音）";
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
    lastApplied = stateRes.last_applied || null;
    await loadClientVoice();
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
    log("=== " + label + " ===");
    setStatus("正在执行：" + label + "…", "", 0);
    try {
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

  $("btnClosePathSelect").onclick = () => {
    $("pathSelectModal").classList.add("hidden");
  };
  $("pathSelectModal").addEventListener("click", (event) => {
    if (event.target === $("pathSelectModal")) {
      $("pathSelectModal").classList.add("hidden");
    }
  });

  // 国服 / 外服 按钮
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
      void syncLobbyLive();
      renderStatusRow();
      // 勾/取消"选人语音"会改变"客户端必须在运行"的判定
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
    void startTask("开启语音包：" + label, () =>
      api("/api/apply", {
        method: "POST",
        body: JSON.stringify({ locale, modules })
      })
    );
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
    );
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

  /* --------------------------------- 播报音量 / 触发方式(右上角) */

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
    // 音量对齐: 跟随客户端音量时, 用它的总音量 × 音效来设置播报音量
    if (followClient && clientVoice.aligned > 0 && clientVoice.aligned !== volume) {
      setVolume(clientVoice.aligned, false);
      const volumes = clientVoice.volumes || { master: "?", sfx: "?", voice: "?" };
      log(
        "播报音量已对齐客户端总音量：" + clientVoice.aligned + "%" +
          "（客户端 总音量 " + volumes.master + " / 音效 " + volumes.sfx + " / 语音 " + volumes.voice + "）"
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
        body: JSON.stringify({ ok, error: error || "", detail: detail || "", kind: lastVoice.kind, championId: lastVoice.championId })
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
   * 让后端的监听跟随界面里选中的语种。
   * 启动时恢复已保存的语种和勾选项；明确取消选择或取消勾选时停止监听。
   */
  async function syncLobbyLive() {
    if (!preferencesReady) return;
    if (!$("modLobbyVoice").checked || !store.selected) {
      await stopLobbyLive();
      return;
    }
    const locale = store.selected;
    if (!locale || locale === lobbyLiveLocale) return;
    lobbyLiveLocale = locale;
    try {
      const response = await fetch("/api/lobby-live/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale })
      });
      const data = await response.json();
      if (data && data.ok) {
        log("选人语音监听已启动：" + data.message + (store.selected ? "" : "（未选语音包，用默认语种）"));
        renderStatusRow();
        // 监听启动时后端会按闭环静音客户端原版台词, 这里同步一下界面状态与音量对齐
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
  setInterval(() => {
    if (!lobbyLiveLocale) return;
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
