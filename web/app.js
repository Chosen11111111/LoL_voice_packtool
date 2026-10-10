/* 英雄联盟语音包切换器 —— 界面逻辑(零依赖, 直接吃后端 REST + SSE) */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MAX_LOG = 800;

  const store = {
    state: null,
    locales: null,
    config: null,
    selected: "",
    logs: [],
    busy: false,
    taskId: null,
    lastUpdate: null
  };

  /* ------------------------------------------------ 基础工具 */

  function log(line) {
    const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    for (const raw of String(line).split("\n")) {
      store.logs.push("[" + stamp + "] " + raw);
    }
    if (store.logs.length > MAX_LOG) store.logs.splice(0, store.logs.length - MAX_LOG);
    renderLogs();
  }

  function renderLogs() {
    const text = store.logs.join("\n") || "[就绪]";
    $("log").textContent = text;
    $("log").scrollTop = $("log").scrollHeight;
    const tail = store.logs.slice(-6).join("\n") || "[就绪]";
    $("miniLog").textContent = tail;
    $("miniLog").scrollTop = $("miniLog").scrollHeight;
  }

  function toast(message, kind) {
    const el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = message;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  function confirmDialog(title, body, okText) {
    return new Promise((resolve) => {
      $("modalTitle").textContent = title;
      $("modalBody").textContent = body;
      $("modalOk").textContent = okText || "确定";
      $("modal").classList.remove("hidden");
      const done = (value) => {
        $("modal").classList.add("hidden");
        $("modalOk").onclick = null;
        $("modalCancel").onclick = null;
        resolve(value);
      };
      $("modalOk").onclick = () => done(true);
      $("modalCancel").onclick = () => done(false);
    });
  }

  async function api(path, options) {
    const response = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, options || {}));
    const payload = await response.json().catch(() => null);
    if (!response.ok || (payload && payload.ok === false && payload.error)) {
      throw new Error((payload && payload.message) || "HTTP " + response.status);
    }
    return payload;
  }

  function setBusy(busy) {
    store.busy = busy;
    for (const id of ["btnApply", "btnRestore", "btnPlan", "btnSync", "btnCheckUpdate", "btnSaveConfig", "btnDetect", "btnDetectInline", "btnDoctorInline"]) {
      const el = $(id);
      if (el) el.disabled = busy;
    }
    $("taskChip").classList.toggle("hidden", !busy && !store.taskId);
  }

  function setProgress(percent, text) {
    $("barFill").style.width = Math.max(0, Math.min(100, percent)) + "%";
    $("taskChipFill").style.width = Math.max(0, Math.min(100, percent)) + "%";
    if (text !== undefined) {
      $("progressText").textContent = text;
      $("taskChipText").textContent = text;
    }
  }

  function selectedModules() {
    const modules = [];
    if ($("modVoice").checked) modules.push("ingame_voice");
    if ($("modLang").checked) modules.push("ingame_lang");
    return modules;
  }

  /* ------------------------------------------------ 渲染 */

  function renderConnection(online) {
    const conn = $("conn");
    conn.classList.toggle("online", online);
    conn.classList.toggle("offline", !online);
    conn.querySelector("span").textContent = online ? "后端已连接" : "后端已断开";
  }

  function renderOverview() {
    const state = store.state;
    if (!state) return;
    const ingame = state.ingame;

    $("statVoice").textContent = ingame.is_voice_active ? "已切换" : "国服原版";
    $("statVoice").className = "stat-value " + (ingame.is_voice_active ? "on" : "off");
    $("statVoiceFoot").textContent = ingame.is_voice_active
      ? ingame.voice.replace(/[【】]/g, "") + " · 备份 " + ingame.voice_backups + " 个"
      : "官方中文语音";

    $("statLang").textContent = ingame.is_lang_active ? "已切换" : "国服原版";
    $("statLang").className = "stat-value " + (ingame.is_lang_active ? "on" : "off");
    $("statLangFoot").textContent = ingame.is_lang_active ? ingame.lang.replace(/[【】]/g, "") : "官方中文文本";

    const locales = store.locales ? store.locales.locales : [];
    $("statPacks").textContent = locales.length + " 个";
    $("statPacks").className = "stat-value";
    $("statPacksFoot").textContent = locales.map((item) => item.code).join(" · ") || "资源目录里还没有语音包";

    const game = state.processes.game_running;
    const client = state.processes.client_running;
    $("statEnv").textContent = game ? "对局中" : client ? "客户端运行中" : "就绪";
    $("statEnv").className = "stat-value " + (game ? "off" : "on");
    $("statEnvFoot").textContent = game ? "对局进行中，禁止切换" : client ? "切换完成后会自动重启生效" : "客户端未运行";

    $("pathSource").textContent = state.paths.sourceDetail || state.paths.source || "—";
    const rows = [
      ["客户端目录", state.paths.leagueDir || "未定位"],
      ["游戏文件目录", state.paths.finalDir || state.paths.message.split("\n")[0]],
      ["语音包目录", state.voiceRoot],
      ["加载器目录", state.lobby && state.lobby.loader_dir ? state.lobby.loader_dir + "（未启用）" : "未配置（大厅功能未启用）"]
    ];
    $("envList").innerHTML = rows
      .map((row) => '<div class="kv-row"><span class="k">' + row[0] + "</span><b>" + escapeHtml(row[1]) + "</b></div>")
      .join("");
    $("appRootLabel").textContent = state.app.appRoot;
    $("brandVersion").textContent = "v" + state.app.version;
    $("voiceRootLabel").textContent = state.voiceRoot;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function renderLocalePicker() {
    const host = $("localePicker");
    const locales = store.locales ? store.locales.locales : [];
    if (!locales.length) {
      host.innerHTML = '<span class="muted small">没有可用语音包，请到「更新与下载」同步</span>';
      return;
    }
    host.innerHTML = "";
    for (const item of locales) {
      const usable = item.has_voice || item.has_lang;
      const chip = document.createElement("button");
      chip.className = "locale-chip" + (item.code === store.selected ? " active" : "") + (usable ? "" : " disabled");
      chip.innerHTML = escapeHtml(item.name) + " <small>" + item.code + "</small>";
      chip.disabled = !usable;
      chip.onclick = () => {
        store.selected = item.code;
        renderLocalePicker();
        $("selectedLocaleHint").textContent = "已选择 " + item.name;
      };
      host.appendChild(chip);
    }
    const current = locales.find((item) => item.code === store.selected);
    $("selectedLocaleHint").textContent = current ? "已选择 " + current.name : "未选择";
  }

  function renderLocaleGrid() {
    const host = $("localeGrid");
    const locales = store.locales ? store.locales.locales : [];
    if (!locales.length) {
      host.innerHTML = '<div class="muted small">资源目录里还没有语音包。可用「更新与下载 → 增量同步」自动下载。</div>';
      return;
    }
    host.innerHTML = "";
    for (const item of locales) {
      const card = document.createElement("div");
      card.className = "locale-card" + (item.active ? " active" : "");
      card.innerHTML =
        '<div class="locale-card-head"><strong>' + escapeHtml(item.name) + "</strong>" +
        (item.active ? '<span class="badge on">当前生效</span>' : '<span class="badge">' + item.code + "</span>") +
        "</div>" +
        '<div class="tags">' +
        '<span class="tag ' + (item.has_voice ? "ok" : "no") + '">对局语音 ' + item.voice_files + "</span>" +
        '<span class="tag ' + (item.map_files ? "ok" : "no") + '">播报员 ' + item.map_files + "</span>" +
        '<span class="tag ' + (item.has_lang ? "ok" : "no") + '">对局文本 ' + item.lang_files + "</span>" +
        "</div>" +
        '<div class="btn-row">' +
        '<button class="btn primary tiny" data-act="all">全套切换</button>' +
        '<button class="btn tiny" data-act="voice">仅对局语音</button>' +
        '<button class="btn tiny" data-act="lang">仅对局文本</button>' +
        "</div>";
      card.querySelector('[data-act="all"]').onclick = () => applyLocale(item.code, ["ingame_voice", "ingame_lang"]);
      card.querySelector('[data-act="voice"]').onclick = () => applyLocale(item.code, ["ingame_voice"]);
      card.querySelector('[data-act="lang"]').onclick = () => applyLocale(item.code, ["ingame_lang"]);
      host.appendChild(card);
    }
  }

  function renderUpdate() {
    const info = store.lastUpdate;
    if (!info) return;
    const rows = [
      ["远程版本", info.info.remoteVersion || "未知"],
      ["本地版本", info.info.localVersion || "未记录"],
      ["缺少文件", String(info.info.missingItems)],
      ["状态", info.info.detail]
    ];
    $("updateInfo").innerHTML = rows
      .map((row) => '<div class="kv-row"><span class="k">' + row[0] + "</span><b>" + escapeHtml(row[1]) + "</b></div>")
      .join("");
    renderInventory(info.inventory);
  }

  function renderInventory(inventory) {
    if (!inventory) return;
    const body = $("inventoryTable").querySelector("tbody");
    body.innerHTML = inventory
      .map((row) => {
        const cell = (value, expect) =>
          '<td class="num ' + (value >= expect ? "good" : "bad") + '">' + value + "/" + expect + "</td>";
        return (
          "<tr><td>" + escapeHtml(row.code) + "</td>" +
          cell(row.wads, 180) + cell(row.choose, 173) + cell(row.ban, 173) + cell(row.champions, 173) +
          "</tr>"
        );
      })
      .join("");
    $("inventoryHint").textContent = "以 180 个对局资源 / 173 个英雄为准";
  }

  function renderSyncLocales() {
    const host = $("syncLocales");
    const config = store.config;
    if (!config) return;
    const locales = config.supportedLocales || ["ja_JP", "ko_KR", "en_US"];
    host.innerHTML = locales
      .map((code) => '<label class="check"><input type="checkbox" value="' + code + '" checked /><span>' + code + "</span></label>")
      .join("");
  }

  function renderSettings() {
    const config = store.config;
    if (!config) return;
    $("cfgLeaguePath").value = config.leaguePath || "";
    $("cfgGamePath").value = config.gamePath || "";
    $("cfgVoiceRoot").value = config.voiceRoot || "";
    $("cfgSupported").value = (config.supportedLocales || []).join(",");
    $("cfgAutoRestart").checked = Boolean(config.autoRestartClient);
    $("cfgPort").value = config.server.port;
    $("cfgToken").value = config.server.token || "";
    $("cfgWebDir").value = config.server.webDir || "web";
    $("cfgFeatureLobbyVoice").checked = Boolean(config.features && config.features.lobbyVoice);
    const select = $("cfgDefaultLocale");
    const codes = (store.locales ? store.locales.locales.map((item) => item.code) : []).concat(config.supportedLocales || []);
    const unique = [...new Set(codes)];
    select.innerHTML = unique.map((code) => '<option value="' + code + '">' + code + "</option>").join("");
    select.value = config.defaultLocale;
  }

  async function refresh() {
    const [state, locales, config] = await Promise.all([
      api("/api/state"),
      api("/api/locales?stats=1"),
      api("/api/config")
    ]);
    store.state = state.state;
    store.locales = locales;
    store.config = config.config;
    if (!store.selected) {
      const active = locales.locales.find((item) => item.code === locales.active_locale);
      const first = locales.locales[0];
      store.selected = active ? active.code : first ? first.code : "";
    }
    renderOverview();
    renderLocalePicker();
    renderLocaleGrid();
    renderSettings();
    renderSyncLocales();
    renderConnection(true);
    setBusy(Boolean(Object.keys(store.state.busy || {}).length));
  }

  function go(view) {
    for (const item of document.querySelectorAll(".nav-item")) {
      item.classList.toggle("active", item.dataset.view === view);
    }
    for (const section of document.querySelectorAll(".view")) {
      section.classList.toggle("active", section.id === "view-" + view);
    }
    const titles = {
      overview: ["概览", "当前语音包状态与一键切换"],
      locales: ["语音包", "本机已安装的语音包及其资源完整度"],
      update: ["更新与下载", "增量同步官方语音包资源"],
      settings: ["设置", "路径、行为与服务参数"],
      logs: ["运行日志", "本次会话的操作与任务日志"]
    };
    $("viewTitle").textContent = titles[view][0];
    $("viewSub").textContent = titles[view][1];
    location.hash = "#/" + view;
  }

  /* ------------------------------------------------ 任务 */

  async function waitTask(id) {
    setBusy(true);
    store.taskId = id;
    $("taskChip").classList.remove("hidden");
    let status = "running";
    while (status === "running" || status === "pending") {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const payload = await api("/api/tasks/" + id);
      status = payload.task.status;
      if (status === "running") continue;
      const result = payload.result || {};
      for (const line of (result.summary && result.summary.lines) || []) log("结果：" + line);
      for (const item of result.results || []) {
        if (!item.ok && item.message) log("失败原因：" + item.message.replace(/\n/g, " "));
      }
      log(result.message || payload.task.error || "任务结束");
      toast(result.message || (status === "succeeded" ? "完成" : "失败"), status === "succeeded" ? "ok" : "err");
    }
    store.taskId = null;
    await refresh().catch(() => undefined);
    setBusy(false);
    setProgress(100, "空闲");
    return status;
  }

  async function startTask(label, request) {
    if (store.busy) {
      toast("已有任务在进行中", "err");
      return;
    }
    log("=== " + label + " ===");
    setProgress(0, "准备中…");
    try {
      const payload = await request();
      await waitTask(payload.task.id);
    } catch (error) {
      log("× " + error.message);
      toast(error.message, "err");
      setBusy(false);
      setProgress(0, "空闲");
    }
  }

  function applyLocale(locale, modules) {
    if (!modules.length) {
      toast("请至少勾选一项切换范围", "err");
      return;
    }
    const names = { ingame_voice: "对局语音", ingame_lang: "对局文本" };
    const text = modules.map((module) => names[module] || module).join(" + ");
    void confirmDialog("切换到 " + locale, "即将把【" + text + "】切换为 " + locale + "。\n原文件会自动备份，可随时恢复官方默认。", "开始切换").then((ok) => {
      if (!ok) return;
      store.selected = locale;
      renderLocalePicker();
      return startTask("切换到 " + locale + "（" + text + "）", () =>
        api("/api/apply", {
          method: "POST",
          body: JSON.stringify({ locale, modules, restartClient: $("optRestart").checked })
        })
      );
    });
  }

  function restoreOfficial() {
    void confirmDialog("恢复官方默认", "将把对局语音与文本还原为国服原版（有备份才会还原）。\n客户端运行时会自动重启以解除占用。", "开始还原").then((ok) => {
      if (!ok) return;
      return startTask("恢复官方默认", () =>
        api("/api/restore", {
          method: "POST",
          body: JSON.stringify({ modules: ["ingame_voice", "ingame_lang"], restartClient: $("optRestart").checked })
        })
      );
    });
  }

  async function runPlan() {
    if (!store.selected) {
      toast("请先选择语音包", "err");
      return;
    }
    try {
      const payload = await api("/api/plan", {
        method: "POST",
        body: JSON.stringify({ locale: store.selected, modules: selectedModules() })
      });
      log("=== 预检 " + store.selected + " ===");
      for (const check of payload.plan.checks) {
        log((check.ok ? "√ " : "× ") + check.module_name + "：" + check.message);
      }
      if (payload.plan.space.needed) log("磁盘：" + (payload.plan.space.message || payload.plan.space.detail));
      for (const warning of payload.plan.warnings) log("! " + warning);
      for (const blocker of payload.plan.blockers) log("× " + blocker.replace(/\n/g, " "));
      toast(payload.plan.ok ? "预检通过，可以开始切换" : "预检未通过，请看日志", payload.plan.ok ? "ok" : "err");
    } catch (error) {
      toast(error.message, "err");
    }
  }

  /* ------------------------------------------------ 事件绑定 */

  $("nav").addEventListener("click", (event) => {
    const item = event.target.closest(".nav-item");
    if (item) go(item.dataset.view);
  });
  window.addEventListener("hashchange", () => {
    const view = location.hash.replace("#/", "") || "overview";
    go(view);
  });
  $("btnRefresh").onclick = () => refresh().then(() => toast("已刷新", "ok")).catch((error) => toast(error.message, "err"));
  $("btnApply").onclick = () => applyLocale(store.selected, selectedModules());
  $("btnRestore").onclick = restoreOfficial;
  $("btnPlan").onclick = runPlan;
  $("btnCancelTask").onclick = async () => {
    if (!store.taskId) return;
    try {
      await api("/api/tasks/" + store.taskId + "/cancel", { method: "POST" });
      log("已请求取消当前任务");
    } catch (error) {
      toast(error.message, "err");
    }
  };
  $("btnCopyRoot").onclick = () => {
    navigator.clipboard.writeText(store.state ? store.state.voiceRoot : "").then(() => toast("路径已复制", "ok"));
  };
  $("btnCopyLog").onclick = () => {
    navigator.clipboard.writeText(store.logs.join("\n")).then(() => toast("日志已复制", "ok"));
  };
  $("btnClearLog").onclick = () => {
    store.logs = [];
    renderLogs();
  };
  $("btnCheckUpdate").onclick = () =>
    startTask("检查更新", async () => {
      const payload = await api("/api/update/check", { method: "POST" });
      return payload;
    }).then(async (status) => {
      if (status !== "succeeded") return;
      const latest = await api("/api/tasks");
      const task = latest.tasks.find((item) => item.kind === "update_check" && item.hasResult);
      const detail = await api("/api/tasks/" + (task ? task.id : ""));
      store.lastUpdate = detail.result;
      renderUpdate();
      await refresh();
    });
  $("btnSync").onclick = () => {
    const codes = [...document.querySelectorAll("#syncLocales input:checked")].map((input) => input.value);
    if (!codes.length) {
      toast("请至少选择一个语种", "err");
      return;
    }
    void confirmDialog("增量同步", "将同步：" + codes.join("、") + "\n已存在的文件会自动跳过，只补缺失部分。", "开始同步").then((ok) => {
      if (!ok) return;
      return startTask("增量同步 " + codes.join("/"), async () => {
        const payload = await api("/api/update/run", { method: "POST", body: JSON.stringify({ locales: codes }) });
        const status = await waitTask(payload.task.id);
        if (status === "succeeded") {
          const detail = await api("/api/tasks/" + payload.task.id);
          if (detail.result) {
            store.lastUpdate = { info: detail.result.remote, inventory: detail.result.inventory };
            renderUpdate();
          }
        }
        await refresh();
        return { task: payload.task };
      });
    });
  };
  $("btnDetect").onclick = detectPaths;
  $("btnDetectInline").onclick = detectPaths;
  $("btnDoctorInline").onclick = runDoctor;
  $("btnSaveConfig").onclick = async () => {
    try {
      const config = {
        leaguePath: $("cfgLeaguePath").value.trim(),
        gamePath: $("cfgGamePath").value.trim(),
        voiceRoot: $("cfgVoiceRoot").value.trim(),
        defaultLocale: $("cfgDefaultLocale").value,
        supportedLocales: $("cfgSupported").value.split(",").map((item) => item.trim()).filter(Boolean),
        autoRestartClient: $("cfgAutoRestart").checked,
        server: {
          port: Number($("cfgPort").value) || 43110,
          token: $("cfgToken").value.trim(),
          webDir: $("cfgWebDir").value.trim() || "web"
        }
      };
      await api("/api/config", { method: "PUT", body: JSON.stringify(config) });
      toast("配置已保存", "ok");
      log("配置已保存：" + JSON.stringify(config));
      await refresh();
    } catch (error) {
      toast(error.message, "err");
    }
  };

  async function detectPaths() {
    try {
      const payload = await api("/api/paths");
      const host = $("candidateList");
      host.innerHTML = "";
      if (!payload.candidates.length) {
        host.innerHTML = '<div class="muted small">没有探测到可用的游戏安装，请手动填写客户端目录。</div>';
        toast("未探测到游戏安装", "err");
        return;
      }
      for (const item of payload.candidates) {
        const row = document.createElement("div");
        row.className = "cand-item";
        row.innerHTML =
          "<span>" + escapeHtml(item.leagueDir || item.path) + "<br><small>" + escapeHtml(item.sourceDetail || item.source) +
          (item.finalDir ? " · 资源目录已就绪" : " · 未找到 DATA/FINAL") + "</small></span>";
        const use = document.createElement("button");
        use.className = "btn tiny";
        use.textContent = "填入";
        use.disabled = !item.hasClient;
        use.onclick = () => {
          $("cfgLeaguePath").value = item.leagueDir || item.path;
          $("cfgGamePath").value = item.gameDir || "";
          toast("已填入，记得点保存", "ok");
        };
        row.appendChild(use);
        host.appendChild(row);
      }
      log("路径探测完成，共 " + payload.candidates.length + " 个候选");
      go("settings");
    } catch (error) {
      toast(error.message, "err");
    }
  }

  async function runDoctor() {
    try {
      const payload = await api("/api/doctor", { method: "POST" });
      const doctor = payload.doctor;
      log("=== 环境自检 ===");
      log("客户端目录：" + (doctor.paths.leagueDir || "未定位"));
      log("游戏文件目录：" + (doctor.paths.finalDir || "未定位"));
      log("语音包目录：" + doctor.config.voiceRoot);
      log("Node：" + doctor.app.node + "  平台：" + doctor.app.platform);
      log("客户端进程：" + (doctor.processes.client_running ? "运行中" : "未运行") + "，对局：" + (doctor.processes.game_running ? "进行中" : "无"));
      log("语音包：" + doctor.locales.map((item) => item.code + (item.voice ? "✓" : "✗")).join(" "));
      $("doctorOut").textContent = JSON.stringify(doctor, null, 2);
      $("doctorOut").classList.remove("hidden");
      toast("自检结果已输出到日志与设置页", "ok");
      go("settings");
    } catch (error) {
      toast(error.message, "err");
    }
  }

  /* ------------------------------------------------ SSE */

  function connectEvents() {
    const events = new EventSource("/api/events");
    events.addEventListener("progress", (event) => {
      const data = JSON.parse(event.data);
      const progress = data.progress;
      setProgress(progress.percent, progress.percent + "% (" + progress.done + "/" + progress.total + ") " + (progress.current || ""));
    });
    events.addEventListener("log", (event) => log(JSON.parse(event.data).line));
    events.addEventListener("done", (event) => {
      const data = JSON.parse(event.data);
      if (data.status === "succeeded") setProgress(100, "完成");
    });
    events.addEventListener("state", () => renderConnection(true));
    events.onerror = () => renderConnection(false);
  }

  /* ------------------------------------------------ 启动 */

  setBusy(false);
  go((location.hash || "#/overview").replace("#/", "") || "overview");
  refresh()
    .then(() => log("已连接后端 v" + store.state.app.version + "，状态就绪"))
    .catch((error) => {
      renderConnection(false);
      toast("无法连接后端：" + error.message, "err");
      log("× 无法连接后端：" + error.message);
    });
  connectEvents();
})();
