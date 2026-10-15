import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { defaultConfig } from "../src/core/config.ts";
import { buildEnv } from "../src/modules/context.ts";
import { applyAll, restoreAll } from "../src/modules/oneclick.ts";
import { projectRoot, makePack, writeFile, readFile, exists } from "./helpers.ts";

// 旧测试助手的 suite 是跨文件全局值；并发矩阵不能放进其他文件会清理的目录。
const matrixRoot = await fs.mkdtemp(path.join(projectRoot, ".tmp", "foreign-matrix-"));
assert.equal(path.dirname(matrixRoot), path.join(projectRoot, ".tmp"));
test.after(async () => { await fs.rm(matrixRoot, { recursive: true, force: true }); });

// Riot Data Dragon languages.json 核对于 2026-10-15；大陆语种也作为防回归对照。
const locales = ["ar_AE", "en_US", "cs_CZ", "de_DE", "el_GR", "en_AU", "en_GB", "en_PH", "en_SG", "es_AR", "es_ES", "es_MX", "fr_FR", "hu_HU", "id_ID", "it_IT", "ja_JP", "ko_KR", "pl_PL", "pt_BR", "ro_RO", "ru_RU", "th_TH", "tr_TR", "vi_VN", "zh_CN", "zh_MY", "zh_TW"];
const files = ["Champions/Ahri", "Champions/Yasuo", "Maps/Shipping/Map11", "Localized/Global"];
const modules = ["ingame_voice", "ingame_lang"] as const;

test("各客户端语种 × Riot/分离目录：真实文件切换、连续换包、还原", { concurrency: 4 }, async (t) => {
  await Promise.all(locales.flatMap((locale, index) => ["riot", "split"].map((layout) => t.test(`${locale} / ${layout}`, async () => {
    const root = await fs.mkdtemp(path.join(matrixRoot, "case-"));
    const install = path.join(root, "Riot Games", "League of Legends");
    const league = layout === "riot" ? install : path.join(install, "LeagueClient");
    const finalDir = path.join(install, "Game", "DATA", "FINAL");
    const voiceRoot = path.join(root, "language");
    await writeFile(path.join(league, "LeagueClient.exe"), "CLIENT");
    await writeFile(path.join(install, "Game", "League of Legends.exe"), "GAME");
    const yamlValue = [locale, `"${locale}"`, `'${locale}'`][index % 3];
    await writeFile(path.join(league, "Config", "LeagueClientSettings.yaml"), `# locale: en_US\r\ninstall:\r\n  globals:\r\n    locale: ${yamlValue} # current\r\n`);
    const other = locale === "en_US" ? "zh_CN" : "en_US";
    const originals = new Map<string, string>();
    for (const name of files) {
      for (const suffix of [`.${locale}`, `.${other}`, ""]) {
        const file = path.join(finalDir, `${name}${suffix}.wad.client`);
        const bytes = `ORIGINAL:${name}:${suffix}`;
        await writeFile(file, bytes);
        originals.set(file, bytes);
      }
    }
    // 非当前语种更多，验证不能再靠数量猜。
    await writeFile(path.join(finalDir, "Champions", `Lux.${other}.wad.client`), "EXTRA");
    for (const target of ["ja_JP", "ko_KR"]) await makePack(voiceRoot, target, { champions: ["Ahri", "Yasuo"], maps: ["Map11"], lobby: 0 });
    const config = defaultConfig();
    Object.assign(config, { leaguePath: league, voiceRoot, autoRestartClient: false });
    config.ui.region = "global";
    const env = await buildEnv({ config, voiceRoot, skipProcess: true, skipAutoDetect: true });
    assert.equal(env.resolution.ok, true, env.resolution.message);
    assert.equal(env.finalDir, finalDir);
    assert.equal(env.baseLocale, locale);
    for (const target of ["ja_JP", "ko_KR"]) {
      const result = await applyAll(env, { locale: target, modules: [...modules], restartClient: false });
      assert.equal(result.ok, true, JSON.stringify({ message: result.message, target, voiceRoot, sources: result.ok ? [] : await fs.readdir(voiceRoot, { recursive: true }).catch(String) }));
      assert.equal(await readFile(path.join(finalDir, `Champions/Ahri.${locale}.wad.client`)), `${target}-Ahri`);
      assert.equal(await readFile(path.join(finalDir, `Champions/Yasuo.${locale}.wad.client`)), `${target}-Yasuo`);
      assert.equal(await readFile(path.join(finalDir, `Maps/Shipping/Map11.${locale}.wad.client`)), `${target}-Map11`);
      assert.equal(await readFile(path.join(finalDir, `Localized/Global.${locale}.wad.client`)), `${target}-LANG`);
      for (const [file, bytes] of originals) {
        if (file.endsWith(`.${locale}.wad.client`)) assert.equal(await readFile(`${file}.chosen_bak`), bytes);
        else assert.equal(await readFile(file), bytes, "不能修改其他语种或公共资源");
      }
    }
    const restored = await restoreAll(env, { modules: [...modules], restartClient: false });
    assert.equal(restored.ok, true, restored.message);
    assert.doesNotMatch(restored.message, /国服/);
    for (const [file, bytes] of originals) {
      assert.equal(await readFile(file), bytes);
      assert.equal(await exists(`${file}.chosen_bak`), false);
    }
  }))));
});

test("多语种无法识别时停止整次对局切换，英文文件与其他语种都保持原样", async () => {
  const root = await fs.mkdtemp(path.join(matrixRoot, "ambiguous-"));
  const league = path.join(root, "League of Legends");
  const voiceRoot = path.join(root, "language");
  const finalDir = path.join(league, "Game", "DATA", "FINAL");
  await writeFile(path.join(league, "LeagueClient.exe"), "CLIENT");
  await writeFile(path.join(league, "Game", "League of Legends.exe"), "GAME");
  for (const locale of ["en_US", "ko_KR"]) await writeFile(path.join(finalDir, `Champions/Ahri.${locale}.wad.client`), locale);
  await makePack(voiceRoot, "ja_JP", { champions: ["Ahri"], maps: [], lobby: 0 });
  const config = { ...defaultConfig(), leaguePath: league, voiceRoot };
  const env = await buildEnv({ config, voiceRoot, skipProcess: true, skipAutoDetect: true });
  const result = await applyAll(env, { locale: "ja_JP", modules: ["ingame_voice"], restartClient: false });
  assert.equal(result.ok, false);
  assert.match(result.message, /无法确定客户端当前语种/);
  for (const locale of ["en_US", "ko_KR"]) {
    const file = path.join(finalDir, `Champions/Ahri.${locale}.wad.client`);
    assert.equal(await readFile(file), locale);
    assert.equal(await exists(`${file}.chosen_bak`), false);
  }
});
