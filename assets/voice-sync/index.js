/**
 * @name voice-sync
 * @description 选人语音替换 —— 把客户端请求的 choose-vo / ban-vo 换成语音包里的音频
 *
 * 原理: 客户端在选人界面会去取
 *   /lol-game-data/assets/v1/champion-choose-vo/<id>.ogg
 *   /lol-game-data/assets/v1/champion-ban-vo/<id>.ogg
 * 我们在运行时把这三个音频入口(HttpURL / fetch / <audio>.src)全部改写成加载器自带的
 * 虚拟源 https://plugins/<插件名>/..., 于是客户端自己播我们的音频 —— 磁盘上的资源包
 * 一个字节都不用改, 也就绕过了它的内容校验。
 *
 * 兜底顺序: 本地语音包 -> 社区数据源 -> 客户端原声。任何一步失败都不会静音。
 *
 * 配置由部署端(软件本体)写两处:
 *   1. 同目录的 config.json   运行时读(改了不用重启客户端)
 *   2. 下面 __VOICE_CONFIG__ 代码块  注入时读(新会话立即生效)
 */
(function initVoiceSync() {
  var TAG = "[voice-sync]";
  var SELF = "voice-sync";
  var CDN = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global";

  // __VOICE_CONFIG_START__
  var enabled = false;
  var locale = "zh_CN";
  var cdnLocale = "zh_cn";
  // __VOICE_CONFIG_END__

  /** 只认选人台词这两类, 其余音频一律不碰。 */
  var KIND_RE = /\/lol-game-data\/assets\/v1\/(champion-choose-vo|champion-ban-vo)\/(\d+)\.ogg$/i;

  function localUrl(kind, id) {
    return "https://plugins/" + SELF + "/voice_assets/" + kind + "/" + id + ".ogg";
  }

  function cdnUrl(kind, id) {
    return CDN + "/" + (cdnLocale || "default") + "/v1/" + kind + "/" + id + ".ogg";
  }

  /** 拦截计数: 用于让软件那边验证"插件真的在客户端里干活了"。 */
  var stat = { hits: 0, at: 0, kind: "", id: "", since: 0 };
  var lastReported = -1;

  /** 把计数写进加载器的 DataStore(会落盘), 软件读它就知道插件跑没跑。 */
  function report() {
    if (stat.hits === lastReported) return;
    lastReported = stat.hits;
    try {
      if (window.DataStore && typeof window.DataStore.set === "function") {
        window.DataStore.set("voice-sync.trace", JSON.stringify({
          hits: stat.hits,
          at: Math.floor(stat.at || Date.now() / 1000),
          kind: stat.kind,
          id: stat.id,
          locale: locale,
          enabled: enabled
        }));
      }
    } catch (e) {}
  }

  /** 把客户端要的原始地址换成我们本地的; 不是选人台词就原样返回。 */
  function rewrite(url) {
    if (!enabled || typeof url !== "string") return url;
    if (locale === "zh_CN") return url;
    var m = url.match(KIND_RE);
    if (!m) return url;
    stat.hits += 1;
    stat.at = Math.floor(Date.now() / 1000);
    stat.kind = m[1];
    stat.id = m[2];
    return localUrl(m[1], m[2]);
  }

  // ---------- 1. 配置(改了 config.json 不用重启客户端) ----------
  function readConfig() {
    if (typeof fetch !== "function") return;
    fetch("https://plugins/" + SELF + "/config.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (cfg) {
        if (!cfg) return;
        enabled = cfg.enabled === true && cfg.locale && cfg.locale !== "zh_CN";
        if (cfg.locale) locale = cfg.locale;
        if (cfg.cdn_locale) cdnLocale = cfg.cdn_locale;
      })
      .catch(function () {});
  }
  readConfig();
  // 每 3 秒重读一次: 软件里开关一改, 客户端这边几秒内就跟上, 不用重启客户端
  setInterval(readConfig, 3000);
  setInterval(report, 5000);

  // ---------- 2. 三个音频入口 ----------
  try {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        var args = Array.prototype.slice.call(arguments);
        args[1] = rewrite(url);
        return origOpen.apply(this, args);
      } catch (e) {
        return origOpen.apply(this, arguments);
      }
    };
  } catch (e) {}

  try {
    if (typeof window.fetch === "function") {
      var origFetch = window.fetch;
      window.fetch = function (input, init) {
        try {
          if (typeof input === "string") {
            input = rewrite(input);
          } else if (input && input.url) {
            var next = rewrite(input.url);
            if (next !== input.url) input = new Request(next, input);
          }
        } catch (e) {}
        return origFetch.call(this, input, init);
      };
    }
  } catch (e) {}

  // <audio src> 是客户端播选人台词最可能走的路径, 这里做三级兜底
  try {
    var desc = Object.getOwnPropertyDescriptor(HTMLAudioElement.prototype, "src");
    if (desc && desc.set) {
      Object.defineProperty(HTMLAudioElement.prototype, "src", {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          return desc.get.call(this);
        },
        set: function (value) {
          var original = value;
          var next = rewrite(value);
          var el = this;
          if (next !== original) {
            el.addEventListener("error", function onLocalFail() {
              var m = String(el.src || "").match(/voice_assets\/(champion-(?:choose|ban)-vo)\/(\d+)\.ogg/);
              if (!m) return;
              el.addEventListener("error", function onCdnFail() {
                console.warn(TAG + " 本地与数据源都失败, 回退客户端原声");
                desc.set.call(el, original);
                try { el.load(); el.play().catch(function () {}); } catch (e) {}
              }, { once: true });
              var fallback = cdnUrl(m[1], m[2]);
              console.warn(TAG + " 本地音频失败, 改用数据源: " + fallback);
              desc.set.call(el, fallback);
              try { el.load(); el.play().catch(function () {}); } catch (e) {}
            }, { once: true });
          }
          return desc.set.call(this, next);
        }
      });
    }
  } catch (e) {}

  console.log(TAG + " 已就绪 enabled=" + enabled + " locale=" + locale);
})();
