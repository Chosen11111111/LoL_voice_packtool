/**
 * 客户端界面文字替换核心(运行在英雄联盟客户端页面里)。
 *
 * 设计约束:
 * - 只用浏览器标准接口(MutationObserver / requestAnimationFrame / localStorage / clipboard),
 *   不依赖任何加载器的私有 API, 所以换成别的加载器也能用。
 * - 整个能力集中在这一个自包含函数里(不引用外部变量), 打包时直接把它转成字符串塞进插件,
 *   因此这里改成任何东西都不需要改打包脚本。
 * - 任何异常都必须自我禁用: 最坏情况是"没翻译", 绝不能把客户端界面搞卡死。
 */

/** 含中日韩文字才算"需要翻译"的原文。 */
export const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

/** 这些标签里的文字绝不动。 */
export const SKIP_TAGS = ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE", "SVG", "CANVAS", "IFRAME", "TITLE", "HEAD"];

/** 默认不动的区域: 输入框、可编辑区(聊天框、昵称编辑等)。 */
export const DEFAULT_SKIP_SELECTORS = ["[contenteditable='true']", "[contenteditable='']", "input", "textarea", "select"];

/**
 * 把一段文字翻译成目标语言。
 * 返回 null 表示"没有对应译文, 保持原样"。
 * 前后空白原样保留, 只有中间的主体参与查表 —— 界面文字常带缩进和换行。
 */
export function translate(text, dict, patterns) {
  if (typeof text !== "string" || text.length === 0) return null;
  const leading = text.match(/^\s*/)[0];
  const trailing = text.match(/\s*$/)[0];
  const core = text.slice(leading.length, text.length - trailing.length);
  if (!core || !CJK.test(core)) return null;
  const direct = Object.prototype.hasOwnProperty.call(dict, core) ? dict[core] : undefined;
  if (typeof direct === "string" && direct.length > 0) return leading + direct + trailing;
  if (patterns) {
    for (let i = 0; i < patterns.length; i += 1) {
      const [re, to] = patterns[i];
      if (re.test(core)) return leading + core.replace(re, to) + trailing;
    }
  }
  return null;
}

/** 是否值得记录进"待翻译清单"(含中文、长度适中、还没有译文)。 */
export function isCollectable(text, dict, maxLength) {
  if (typeof text !== "string") return false;
  const core = text.trim();
  if (!core || core.length > maxLength) return false;
  if (!CJK.test(core)) return false;
  return !Object.prototype.hasOwnProperty.call(dict, core);
}

/**
 * 安装文字替换器。返回一个控制器(可 off/on/dump/stats), 出任何问题都自动禁用自己。
 * options: { dict, patterns, collect, maxLength, skipSelectors, storageKey, debug }
 */
export function createTextReplacer(options) {
  const opts = options || {};
  const dict = opts.dict || {};
  const patterns = opts.patterns || [];
  const collect = opts.collect !== false;
  // 收集上限: 太短的没意义, 太长的多半是聊天/公告。原来定 40, 但客户端的提示与说明
  // 经常超过 40 字, 那样就永远收不到、也就永远补不上 —— 放宽到 80。
  const maxLength = typeof opts.maxLength === "number" ? opts.maxLength : 80;
  const skipSelectors = opts.skipSelectors || ["[contenteditable='true']", "input", "textarea"];
  const storageKey = opts.storageKey || "__tr_collected";
  const SKIP_TAGS = ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE", "SVG", "CANVAS", "IFRAME", "TITLE", "HEAD"];
  const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
  const state = { on: true, replaced: 0, scanned: 0, failed: 0, error: "" };
  const written = new WeakMap();
  const pending = new Set();
  const collected = new Set();
  let scheduled = false;

  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved) for (const item of JSON.parse(saved)) collected.add(item);
  } catch (error) { /* 存储不可用不影响替换 */ }

  /** 上报地址: 本机软件(端口固定)。用 text/plain 发, 避免浏览器跨域预检, 发出去就行, 不读回执。 */
  const REPORT_URL = opts.reportUrl === null ? "" : (opts.reportUrl || "http://127.0.0.1:43110/api/textpack/collect");
  let reported = false;

  function saveCollection() {
    try { window.localStorage.setItem(storageKey, JSON.stringify([...collected])); } catch (error) { /* 忽略 */ }
  }

  /**
   * 把"看到但没翻到"的中文清单交出去, 供之后补字典。
   *
   * 首选加载器的 DataStore: 它由注入核心直接落盘成 <加载器目录>\datastore, 不经过网络,
   * 因此不会被客户端页面的安全策略拦掉(实测跨域 fetch 会被拦, 那份清单就丢了)。
   * 网络回传作为补充手段保留。
   */
  const STORE_KEY = "text-replacer.collected";

  function reportCollection() {
    if (reported) return;
    reported = true;
    // 先跟上一次交上去的清单合并, 只增不减 —— 客户端每次重启内存都会重置,
    // 不合并的话新会话会把之前攒的整份覆盖掉(实测被覆盖成更少的条数)。
    try {
      if (window.DataStore && typeof window.DataStore.get === "function") {
        const old = window.DataStore.get(STORE_KEY, "");
        if (typeof old === "string" && old) {
          const parsed = JSON.parse(old);
          if (Array.isArray(parsed.collected)) {
            for (const item of parsed.collected) if (typeof item === "string") collected.add(item);
          }
        }
      }
    } catch (error) { /* 拿不到就算了 */ }
    const payload = JSON.stringify({ collected: [...collected], replaced: state.replaced, scanned: state.scanned });
    let stored = false;
    try {
      if (window.DataStore && typeof window.DataStore.set === "function") {
        window.DataStore.set(STORE_KEY, payload);
        stored = true;
      }
    } catch (error) { /* 没有加载器接口就退回网络 */ }
    try {
      if (!stored && REPORT_URL) {
        fetch(REPORT_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: payload }).catch(() => undefined);
      }
    } catch (error) { /* 不影响客户端 */ }
    return stored;
  }

  function shouldSkip(element) {
    let node = element;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 40) {
      const tag = node.tagName;
      if (tag && SKIP_TAGS.indexOf(tag) >= 0) return true;
      if (tag === "BODY" || tag === "HTML") return false;
      for (let i = 0; i < skipSelectors.length; i += 1) {
        try { if (node.matches && node.matches(skipSelectors[i])) return true; } catch (error) { /* 选择器不合法就忽略 */ }
      }
      node = node.parentElement;
      depth += 1;
    }
    return false;
  }

  function handleTextNode(node) {
    const value = node.nodeValue;
    if (typeof value !== "string" || value.length === 0) return;
    if (written.get(node) === value) return;            // 是我们自己刚写的, 不要再动
    state.scanned += 1;
    const parent = node.parentElement;
    if (parent && shouldSkip(parent)) return;
    const result = translate(value, dict, patterns);
    if (result !== null) {
      if (result === value) return;
      written.set(node, result);
      try { node.nodeValue = result; state.replaced += 1; } catch (error) { state.failed += 1; }
      return;
    }
    if (collect) {
      const core = value.trim();
      if (core.length > 0 && core.length <= maxLength && CJK.test(core) && !collected.has(core)) {
        collected.add(core);
        saveCollection();
      }
    }
  }

  /** 手动深度优先遍历(不用 TreeWalker, 因为要能递归进 shadow root, 也好测试)。 */
  function walk(root, depth) {
    if (!state.on || !root || depth > 60) return;
    const children = root.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (child.nodeType === 3) handleTextNode(child);
        else if (child.nodeType === 1) {
          if (child.shadowRoot) { observe(child.shadowRoot); walk(child.shadowRoot, depth + 1); }
          walk(child, depth + 1);
        }
      }
    }
    if (root.shadowRoot && root.nodeType === 1) { observe(root.shadowRoot); walk(root.shadowRoot, depth + 1); }
  }

  function flush() {
    scheduled = false;
    if (!state.on) return;
    if (state.error) return;
    const queue = [...pending];
    pending.clear();
    try {
      for (const node of queue) {
        if (!node.isConnected) continue;
        if (node.nodeType === 3) handleTextNode(node);
        else walk(node, 0);
      }
    } catch (error) {
      state.error = String((error && error.message) || error);
      state.on = false;                                  // 自我禁用, 绝不影响客户端
      try { console.error("[text-replacer] 出错已自动停用:", error); } catch (e) { /* 忽略 */ }
    }
  }

  function schedule(node) {
    if (!state.on || state.error) return;
    pending.add(node);
    if (pending.size > 4000) pending.clear();            // 极端情况下宁可漏也不卡
    if (scheduled) return;
    scheduled = true;
    try { window.requestAnimationFrame(flush); } catch (error) { flush(); }
  }

  const observed = new WeakSet();
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") schedule(record.target);
      else for (const node of record.addedNodes) schedule(node);
    }
  });

  function observe(root) {
    if (!root || observed.has(root)) return;
    try {
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      observed.add(root);
    } catch (error) { /* 观察失败不影响已处理的部分 */ }
  }

  // 新挂上来的 shadow root 也要被观察到(客户端大量使用组件)
  try {
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = original.call(this, init);
      try { observe(root); schedule(root); } catch (error) { /* 忽略 */ }
      return root;
    };
  } catch (error) { /* 忽略 */ }

  observe(document.documentElement);
  walk(document.body || document.documentElement, 0);
  try {
    window.addEventListener("pagehide", reportCollection);
    window.setTimeout(reportCollection, 15000);   // 界面稳定后交一次
    window.setInterval(() => { reported = false; reportCollection(); }, 120000);   // 之后每两分钟再交一次
  } catch (error) { /* 忽略 */ }

  const controller = {
    get on() { return state.on; },
    off() { state.on = false; return "off"; },
    on_() { state.on = true; state.error = ""; walk(document.body || document.documentElement, 0); return "on"; },
    stats() { return { replaced: state.replaced, scanned: state.scanned, failed: state.failed, error: state.error, collected: collected.size }; },
    /** 导出"没翻译到"的中文清单(按出现次数无从统计, 按长度排序)。 */
    report: reportCollection,
    dump() {
      const list = [...collected].sort();
      const text = JSON.stringify(list, null, 2);
      try { navigator.clipboard.writeText(text); } catch (error) { /* 忽略 */ }
      return list;
    },
    clear() { collected.clear(); saveCollection(); return "cleared"; },
    translate
  };
  return controller;
}
