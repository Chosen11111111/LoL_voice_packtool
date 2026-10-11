/** 渠道(国服/外服): 右上角按钮说了算, 差异集中在渠道档案里。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectBaseLocale } from "../src/packs/baselocale.ts";
import { CN_BUNDLE_PROXY, CN_MANIFEST_ID, downloadProfile, regionProfile, resolveRegion } from "../src/packs/region.ts";

test("右上角按钮优先: 选了外服就走外服, 只有 auto 才用探测结果", () => {
  assert.deepEqual(resolveRegion("global", "cn"), { region: "global", source: "ui" });
  assert.deepEqual(resolveRegion("cn", "global"), { region: "cn", source: "ui" });
  assert.deepEqual(resolveRegion("auto", "global"), { region: "global", source: "detected" });
  assert.deepEqual(resolveRegion(null, "cn"), { region: "cn", source: "detected" });
  assert.deepEqual(resolveRegion("", "cn"), { region: "cn", source: "detected" }, "空值等于自动");
});

test("渠道档案: 自带语种与下载地址都不一样", () => {
  assert.equal(regionProfile("cn").fallbackBaseLocale, "zh_CN");
  assert.equal(regionProfile("global").fallbackBaseLocale, "en_US");
  assert.match(regionProfile("cn").bundleBase, /chosen\.cc\.cd/, "国服走国内镜像");
  assert.match(regionProfile("global").bundleBase, /riotcdn\.net/, "外服直连 Riot 官方 CDN");
});

test("下载档案: 默认值按渠道替换, 用户自己改过的就听用户的", () => {
  const cn = downloadProfile({ bundleProxy: CN_BUNDLE_PROXY, manifestId: CN_MANIFEST_ID }, "cn");
  assert.equal(cn.bundleBase, CN_BUNDLE_PROXY);
  assert.equal(cn.manifestId, CN_MANIFEST_ID);

  // 外服 + 还是国服默认值 -> 换成 Riot CDN; 清单 ID 不能瞎猜, 留空让用户填
  const global = downloadProfile({ bundleProxy: CN_BUNDLE_PROXY, manifestId: CN_MANIFEST_ID }, "global");
  assert.match(global.bundleBase, /riotcdn\.net/);
  assert.equal(global.manifestOrigin, "https://lol.secure.dyn.riotcdn.net");
  assert.equal(global.manifestId, "", "外服清单 ID 随版本变化, 不能沿用国服的");

  // 用户显式填过 -> 一律尊重
  const custom = downloadProfile({ bundleProxy: "https://my.mirror/bundles", manifestId: "ABC123" }, "global");
  assert.equal(custom.bundleBase, "https://my.mirror/bundles");
  assert.equal(custom.manifestId, "ABC123");
});

test("基准语种兜底跟随渠道(探测不到时: 国服 zh_CN / 外服 en_US)", async () => {
  const cn = await detectBaseLocale({ finalDir: null, leagueDir: null, fallbackLocale: "zh_CN" });
  assert.equal(cn.locale, "zh_CN");
  const global = await detectBaseLocale({ finalDir: null, leagueDir: null, fallbackLocale: "en_US" });
  assert.equal(global.locale, "en_US");
  const none = await detectBaseLocale({ finalDir: null, leagueDir: null });
  assert.equal(none.locale, "zh_CN", "没给渠道兜底值时保持老行为");
});
