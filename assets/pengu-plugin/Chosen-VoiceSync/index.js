/**
 * @name Chosen-VoiceSync
 * @author League Voice Toolkit
 * @description Lobby champion select / ban voice replacement (ja_JP / ko_KR / en_US / custom VO)
 *
 * 工作方式:
 *   1. 把选人/禁用台词的音频请求重定向到插件目录下挂载的 voice_assets(本地直读, 零延迟);
 *   2. 本地文件缺失或解码失败 -> 回退到 CommunityDragon 对应语种 CDN;
 *   3. CDN 也失败 -> 回退官方客户端原生音频, 绝不出现静音。
 *
 * 配置来源(优先级):
 *   1. 宿主工具写入的 config.json(enabled=false 时立即停手, 无需重启客户端);
 *   2. 本文件下方的 __CHOSEN_VOICE_CONFIG_START__ 配置块(兜底)。
 */
(function initVoiceSync() {
  const LOG_PREFIX = "[Chosen-VoiceSync]";

  // __CHOSEN_VOICE_CONFIG_START__
  let enabled = false;
  let targetLocale = "zh_CN";
  let targetCdnLocale = "zh_cn";
  // __CHOSEN_VOICE_CONFIG_END__

  const CDN_LOCALE_MAP = {
    ja_JP: "ja_jp",
    ko_KR: "ko_kr",
    en_US: "default",
    zh_CN: "zh_cn",
    zh_TW: "zh_tw",
    de_DE: "de_de",
    fr_FR: "fr_fr",
    es_ES: "es_es",
    es_MX: "es_mx",
    ru_RU: "ru_ru",
  };

  const PLUGIN_BASE = "https://plugins/Chosen-VoiceSync";
  const CDN_BASE = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global";

  async function loadPluginConfig() {
    try {
      const response = await fetch(PLUGIN_BASE + "/config.json", { cache: "no-store" });
      if (!response.ok) return;
      const config = await response.json();
      if (!config || config.enabled === false || !config.locale || config.locale === "zh_CN") {
        enabled = false;
        targetLocale = "zh_CN";
        targetCdnLocale = "zh_cn";
        console.log(LOG_PREFIX + " disabled by config.json");
        return;
      }
      targetLocale = config.locale;
      targetCdnLocale = config.cdn_locale || CDN_LOCALE_MAP[targetLocale] || "default";
      enabled = true;
      console.log(LOG_PREFIX + " config loaded: locale=" + targetLocale + " cdn=" + targetCdnLocale);
    } catch (error) {
      /* 配置读不到就保持脚本内配置块的状态 */
    }
  }

  function localUrl(type, champId) {
    return PLUGIN_BASE + "/voice_assets/" + type + "/" + champId + ".ogg";
  }

  function cdnUrl(type, champId) {
    const locale = targetCdnLocale || CDN_LOCALE_MAP[targetLocale] || "default";
    return CDN_BASE + "/" + locale + "/v1/" + type + "/" + champId + ".ogg";
  }

  function transformAudioUrl(url) {
    if (!url || typeof url !== "string") return url;
    if (!enabled || targetLocale === "zh_CN") return url;
    const choose = url.match(/\/lol-game-data\/assets\/v1\/champion-choose-vo\/(\d+)\.ogg/i);
    if (choose) return localUrl("champion-choose-vo", choose[1]);
    const ban = url.match(/\/lol-game-data\/assets\/v1\/champion-ban-vo\/(\d+)\.ogg/i);
    if (ban) return localUrl("champion-ban-vo", ban[1]);
    return url;
  }

  // 1) XMLHttpRequest
  try {
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      const args = Array.prototype.slice.call(arguments);
      try {
        args[1] = transformAudioUrl(url);
      } catch (error) {
        console.error(LOG_PREFIX + " xhr rewrite failed", error);
      }
      return originalOpen.apply(this, args);
    };
  } catch (error) {
    /* ignore */
  }

  // 2) fetch
  try {
    if (window.fetch) {
      const originalFetch = window.fetch;
      window.fetch = function (input, init) {
        try {
          if (typeof input === "string") input = transformAudioUrl(input);
          else if (input && input.url) input = new Request(transformAudioUrl(input.url), input);
        } catch (error) {
          console.error(LOG_PREFIX + " fetch rewrite failed", error);
        }
        return originalFetch.call(this, input, init);
      };
    }
  } catch (error) {
    /* ignore */
  }

  // 3) HTMLAudioElement.src: 本地 -> CDN -> 官方原声 三级兜底
  try {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLAudioElement.prototype, "src");
    if (descriptor && descriptor.set) {
      Object.defineProperty(HTMLAudioElement.prototype, "src", {
        set(value) {
          const original = value;
          const transformed = transformAudioUrl(value);
          if (transformed !== original) {
            this.addEventListener(
              "error",
              function onLocalError() {
                const current = this.src || "";
                const match = current.match(/voice_assets\/(champion-(?:choose|ban)-vo)\/(\d+)\.ogg/);
                if (!match) return;
                const fallback = cdnUrl(match[1], match[2]);
                this.addEventListener(
                  "error",
                  function onCdnError() {
                    console.warn(LOG_PREFIX + " cdn failed, using official audio");
                    descriptor.set.call(this, original);
                    this.load();
                    this.play().catch(function () {});
                  },
                  { once: true }
                );
                console.warn(LOG_PREFIX + " local audio failed, falling back to cdn: " + fallback);
                descriptor.set.call(this, fallback);
                this.load();
                this.play().catch(function () {});
              },
              { once: true }
            );
          }
          return descriptor.set.call(this, transformed);
        },
        get() {
          return descriptor.get.call(this);
        },
      });
    }
  } catch (error) {
    /* ignore */
  }

  loadPluginConfig().finally(function () {
    console.log(LOG_PREFIX + " hooks ready, enabled=" + enabled + " locale=" + targetLocale);
  });
})();
