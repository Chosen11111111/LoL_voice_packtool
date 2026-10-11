/** 渠道(国服/外服): 右上角按钮说了算, 差异集中在渠道档案里。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectBaseLocale } from "../src/packs/baselocale.ts";
import { regionProfile, resolveRegion } from "../src/packs/region.ts";

test("右上角按钮优先: 选了外服就走外服, 只有 auto 才用探测结果", () => {
  assert.deepEqual(resolveRegion("global", "cn"), { region: "global", source: "ui" });
  assert.deepEqual(resolveRegion("cn", "global"), { region: "cn", source: "ui" });
  assert.deepEqual(resolveRegion("auto", "global"), { region: "global", source: "detected" });
  assert.deepEqual(resolveRegion(null, "cn"), { region: "cn", source: "detected" });
  assert.deepEqual(resolveRegion("", "cn"), { region: "cn", source: "detected" }, "空值等于自动");
});

test("渠道档案: 两个渠道的自带语种与说明都不一样", () => {
  assert.equal(regionProfile("cn").label, "国服");
  assert.equal(regionProfile("global").label, "外服");
  assert.equal(regionProfile("cn").fallbackBaseLocale, "zh_CN");
  assert.equal(regionProfile("global").fallbackBaseLocale, "en_US", "外服客户端多半是英文, 不能拿 zh_CN 去替换槽位");
  assert.match(regionProfile("global").detail, /Riot/);
});

test("基准语种兜底跟随渠道(探测不到时: 国服 zh_CN / 外服 en_US)", async () => {
  const cn = await detectBaseLocale({ finalDir: null, leagueDir: null, fallbackLocale: "zh_CN" });
  assert.equal(cn.locale, "zh_CN");
  const global = await detectBaseLocale({ finalDir: null, leagueDir: null, fallbackLocale: "en_US" });
  assert.equal(global.locale, "en_US");
  const none = await detectBaseLocale({ finalDir: null, leagueDir: null });
  assert.equal(none.locale, "zh_CN", "没给渠道兜底值时保持老行为");
});
