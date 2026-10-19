/** HTTP API 端到端: 通过接口完成一次"全套切换 -> 状态 -> 还原"。 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { invalidateConfigCache, loadConfig, saveConfig } from "../src/core/config.ts";
import { setClientRunningOverride } from "../src/core/win/processes.ts";
import { taskManager } from "../src/tasks/manager.ts";
import { lobbyLive } from "../src/modules/lobbyLive.ts";
import { startApiServer } from "../src/server/api.ts";
import type { RunningServer } from "../src/server/http.ts";
import { cleanupSuite, exists, makeDirSafe, makeFinalDir, makePack, makeTempDir, readFile, useSuite, writeFile } from "./helpers.ts";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["LEAGUE_VOICE_CONFIG", "LEAGUE_VOICE_ROOT", "LOCALAPPDATA", "LEAGUE_PATH"];

let running: RunningServer | null = null;
let base = "";
let fixture: {
  root: string;
  voiceRoot: string;
  leagueDir: string;
  finalDir: string;
} | null = null;

async function post(pathname: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function readFileBuffer(file: string): Promise<Buffer> {
  const fs = await import("node:fs/promises");
  return fs.readFile(file);
}

async function get(pathname: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${pathname}`);
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function waitTask(id: string, timeoutMs = 60000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await get(`/api/tasks/${id}`);
    if (json?.task && json.task.status !== "running" && json.task.status !== "pending") return json;
    if (Date.now() > deadline) throw new Error(`任务 ${id} 超时未结束`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

useSuite("server");

describe("HTTP API 端到端", () => {
before(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // 端到端测试环境里没有真实客户端: 统一视为"客户端在运行",
  // 这样"开启语音包需要客户端"的新规则不会挡掉正常的流程测试(另有专门用例验证拦截逻辑)
  setClientRunningOverride(async () => true);
  const root = await makeTempDir("server-e2e");
  const voiceRoot = path.join(root, "voice");
  const leagueDir = path.join(root, "install", "LeagueClient");
  const finalDir = path.join(root, "install", "Game", "DATA", "FINAL");

  await makePack(voiceRoot, "ja_JP", { champions: ["Ahri"], maps: ["Map11"], lobby: 2 });
  await makeFinalDir(finalDir, { champions: ["Ahri"], maps: ["Map11"] });
  await writeFile(path.join(root, "install", "Game", "League of Legends.exe"), "fake-game-exe");
  await writeFile(path.join(leagueDir, "LeagueClient.exe"), "fake-client");
  await writeFile(path.join(leagueDir, "d3d9.dll"), "official-proxy");
  await writeFile(path.join(leagueDir, "Config", "LeagueClientSettings.yaml"), 'locale: "zh_CN"\n');

  const configFile = path.join(root, "config.json");
  await writeFile(
    configFile,
    JSON.stringify(
      {
        leaguePath: leagueDir,
        voiceRoot,
        defaultLocale: "ja_JP",
        supportedLocales: ["ja_JP"],
        autoRestartClient: false
      },
      null,
      2
    )
  );

  process.env.LEAGUE_VOICE_CONFIG = configFile;
  process.env.LEAGUE_VOICE_ROOT = voiceRoot;
  process.env.LOCALAPPDATA = path.join(root, "localappdata");
  delete process.env.LEAGUE_PATH;
  invalidateConfigCache();

  const started = await startApiServer({ host: "127.0.0.1", port: 0 });
  running = started.running;
  base = `http://127.0.0.1:${started.running.port}`;
  fixture = { root, voiceRoot, leagueDir, finalDir };
});

after(async () => {
  await running?.close();
  setClientRunningOverride(null);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key]!;
  }
  invalidateConfigCache();
  await cleanupSuite();
});

test("GET /api/health 返回服务信息", async () => {
  const { status, json } = await get("/api/health");
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.api_version, 1);
});

test("GET /api/state 反映配置里的安装路径与当前状态", async () => {
  const { json } = await get("/api/state");
  assert.equal(json.ok, true);
  assert.equal(json.state.paths.leagueDir, fixture!.leagueDir);
  assert.equal(json.state.paths.finalDir, fixture!.finalDir);
  assert.equal(json.state.ingame.is_voice_active, false);
  assert.equal(json.state.voiceRoot, fixture!.voiceRoot);
});

test("GET /api/locales 列出可用语言包", async () => {
  const { json } = await get("/api/locales?stats=0");
  assert.equal(json.ok, true);
  assert.deepEqual(json.locales.map((item: any) => item.code), ["ja_JP"]);
  assert.equal(json.locales[0].has_voice, true);
});

test("POST /api/plan 干跑预检通过且不修改任何文件", async () => {
  const { json } = await post("/api/plan", { locale: "ja_JP" });
  assert.equal(json.ok, true);
  assert.equal(json.plan.ok, true, JSON.stringify(json.plan.blockers));
  // 默认只检查对局语音 + 对局文本(大厅语音默认不在流程里)
  assert.equal(json.plan.checks.length, 2);
  assert.deepEqual(json.plan.checks.map((check: any) => check.module), ["ingame_voice", "ingame_lang"]);
  assert.equal(await readFile(path.join(fixture!.finalDir, "Champions", "Ahri.zh_CN.wad.client")), "CN-Ahri");
});

test("POST /api/apply 全链路切换(对局语音+对局语言)", async () => {
  const { json } = await post("/api/apply", {
    locale: "ja_JP",
    restartClient: false,
    modules: ["ingame_voice", "ingame_lang"]
  });
  assert.equal(json.ok, true);
  const finished = await waitTask(json.task.id);
  assert.equal(finished.task.status, "succeeded", JSON.stringify(finished.result));
  assert.equal(finished.result.ok, true, JSON.stringify(finished.result.summary));

  assert.equal(await readFile(path.join(fixture!.finalDir, "Champions", "Ahri.zh_CN.wad.client")), "ja_JP-Ahri");
  assert.equal(await readFile(path.join(fixture!.finalDir, "Maps", "Shipping", "Map11.zh_CN.wad.client")), "ja_JP-Map11");
  assert.equal(await readFile(path.join(fixture!.finalDir, "Localized", "Global.zh_CN.wad.client")), "ja_JP-LANG");

  const state = await get("/api/state");
  assert.equal(state.json.state.ingame.is_voice_active, true);
});

test("空模块列表 = 一个都不切(不能被当成『全都要』)", async () => {
  // 只勾了"客户端界面文字"时, 前端发的就是 modules: []。这里必须什么都不做。
  // 曾经 asModules 把空数组折成 undefined, 而 undefined 的意思是"没指定=全部",
  // 于是用户只勾了客户端文字, 结果对局语音/对局文字也一起被切了。
  const file = path.join(fixture!.finalDir, "Champions", "Ahri.zh_CN.wad.client");
  const before = await readFile(file);
  const before2 = (await get("/api/state")).json.state.ingame;
  // 故意用一个和上文不同的语言: 万一又被换成默认值, 文件内容一定会变, 测试就会挂
  const { json } = await post("/api/apply", { locale: "ko_KR", restartClient: false, modules: [] });
  assert.equal(json.ok, true);
  const finished = await waitTask(json.task.id);
  assert.equal(finished.task.status, "succeeded", JSON.stringify(finished.result));
  assert.equal(await readFile(file), before, "空模块列表不该改动任何游戏文件");
  // 注意: 不能断言"未切换" —— 上一个用例已经把对局语音切成了 ja_JP, 这里要比的是"没被这次调用改动"。
  const state = await get("/api/state");
  assert.equal(state.json.state.ingame.active_locale ?? "", before2.active_locale ?? "", "什么都没勾时, 生效语种不该变");
});

test("客户端未启动: 只有勾选选人语音才拦截(对局语音/语言不受影响)", async () => {
  setClientRunningOverride(async () => false);
  try {
    // 含选人语音 -> 明确拒绝
    const blocked = await post("/api/apply", { locale: "ja_JP", modules: ["lobby_voice"] });
    assert.equal(blocked.json.ok, false);
    assert.equal(blocked.json.blocked, true);
    assert.match(blocked.json.message, /英雄联盟未启动/);

    // 一键开启默认包含选人语音 -> 同样拒绝
    const oneClick = await post("/api/oneclick/apply", { locale: "ja_JP" });
    assert.equal(oneClick.json.blocked, true);

    // 只勾对局语音 -> 允许(只改游戏文件, 不需要客户端在运行)
    const allowed = await post("/api/apply", { locale: "ja_JP", restartClient: false, modules: ["ingame_voice"] });
    assert.equal(allowed.json.blocked, undefined, "纯对局模块不该被拦截");
    assert.equal(allowed.json.ok, true);
    if (allowed.json.task?.id) await waitTask(allowed.json.task.id);
  } finally {
    setClientRunningOverride(async () => true);
  }
});

test("POST /api/restore 全部还原为官方默认", async () => {
  const { json } = await post("/api/restore", { restartClient: false, modules: ["lobby_lang", "ingame_voice", "ingame_lang"] });
  assert.equal(json.ok, true);
  const finished = await waitTask(json.task.id);
  assert.equal(finished.task.status, "succeeded", JSON.stringify(finished.result));
  assert.equal(finished.result.ok, true, JSON.stringify(finished.result.summary));

  assert.equal(await readFile(path.join(fixture!.finalDir, "Champions", "Ahri.zh_CN.wad.client")), "CN-Ahri");
  assert.equal(await readFile(path.join(fixture!.finalDir, "Localized", "Global.zh_CN.wad.client")), "CN-LANG");

  const state = await get("/api/state");
  assert.equal(state.json.state.ingame.is_voice_active, false);
});

test("大厅选人语音: 开启后走 LCU 监听(不改客户端文件), 关闭能停掉", async () => {
  const d3d9Before = await readFile(path.join(fixture!.leagueDir, "d3d9.dll"));
  const pluginDirExists = await exists(path.join(fixture!.leagueDir, "Plugins"));

  const { json } = await post("/api/apply", { locale: "ja_JP", modules: ["lobby_voice"], restartClient: false });
  assert.equal(json.ok, true);
  const finished = await waitTask(json.task.id);
  assert.equal(finished.result.ok, true, JSON.stringify(finished.result.summary));
  assert.equal(finished.result.results[0].detail.mechanism, "lcu-live");
  assert.equal(finished.result.results[0].detail.locale, "ja_JP");

  // 状态与监听引擎一致
  const state = await get("/api/state");
  assert.equal(state.json.state.lobby.enabled, true);
  assert.equal(state.json.state.lobby.mechanism, "lcu-live");
  assert.equal(state.json.state.lobby_live.running, true);
  assert.equal(state.json.state.lobby_live.locale, "ja_JP");
  assert.equal(state.json.state.lobby_live.available, 2);

  // 客户端目录一个字节都没动、也没有新建目录
  assert.equal(await readFile(path.join(fixture!.leagueDir, "d3d9.dll")), d3d9Before);
  assert.equal(await exists(path.join(fixture!.leagueDir, "Plugins")), pluginDirExists);

  // 关闭后引擎停止
  const closed = await post("/api/restore", { modules: ["lobby_voice"], restartClient: false });
  const closedTask = await waitTask(closed.json.task.id);
  assert.equal(closedTask.result.ok, true);
  const after = await get("/api/state");
  assert.equal(after.json.state.lobby_live.running, false);
  assert.equal(after.json.state.lobby.enabled, false);
});

test("大厅选人语音: 语音包里没有该语种时明确失败", async () => {
  const { json } = await post("/api/apply", { locale: "ko_KR", modules: ["lobby_voice"], restartClient: false });
  assert.equal(json.ok, true);
  const finished = await waitTask(json.task.id);
  assert.equal(finished.result.ok, false);
  assert.equal(finished.task.status, "failed");
  assert.match(String(finished.result.results[0].reason), /资源缺失/);
  const state = await get("/api/state");
  assert.equal(state.json.state.lobby_live.running, false);
});

test("POST /api/packs/import 上传压缩包 -> 自动出现在语言包列表", async () => {
  const packRoot = path.join(fixture!.root, "incoming");
  const staging = path.join(packRoot, "staging");
  const { makePack } = await import("./helpers.ts");
  await makePack(staging, "ko_KR", { champions: ["Ahri"], maps: [], lobby: 2 });
  const zip = path.join(packRoot, "英雄联盟_ko_KR.zip");
  const { run } = await import("../src/core/win/shell.ts");
  const zipped = await run("tar", ["-a", "-cf", zip, "-C", staging, "ko_KR"]);
  assert.equal(zipped.ok, true, zipped.stderr || zipped.error);

  const bytes = await readFileBuffer(zip);
  const response = await fetch(`${base}/api/packs/import?name=${encodeURIComponent("英雄联盟_ko_KR.zip")}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { ok: boolean; task: { id: string } };
  assert.equal(payload.ok, true);

  const finished = await waitTask(payload.task.id);
  assert.equal(finished.task.status, "succeeded", JSON.stringify(finished.result));
  assert.equal(finished.result.code, "ko_KR");
  assert.equal(finished.result.installed, true);

  // 装完必须直接出现在语言包列表里(下拉栏的数据源)
  const locales = await get("/api/locales?stats=1");
  const codes = locales.json.locales.map((item: any) => item.code);
  assert.ok(codes.includes("ko_KR"), "导入的语音包要出现在列表里: " + codes.join(","));
  assert.ok(await exists(path.join(fixture!.voiceRoot, "ko_KR", "DATA", "FINAL", "Champions", "Ahri.ko_KR.wad.client")));

  // 而且能直接用来切换
  const applied = await post("/api/apply", { locale: "ko_KR", modules: ["ingame_voice"], restartClient: false });
  const appliedDone = await waitTask(applied.json.task.id);
  assert.equal(appliedDone.result.ok, true, JSON.stringify(appliedDone.result.summary));
  assert.equal(await readFile(path.join(fixture!.finalDir, "Champions", "Ahri.zh_CN.wad.client")), "ko_KR-Ahri");
  await post("/api/restore", { modules: ["ingame_voice"], restartClient: false }).then((r) => waitTask(r.json.task.id));
});

test("POST /api/packs/import 不支持的格式直接报错", async () => {
  const response = await fetch(`${base}/api/packs/import?name=pack.txt`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from("not an archive")
  });
  const payload = (await response.json()) as { ok: boolean; message?: string };
  assert.equal(payload.ok, false);
  assert.match(String(payload.message), /不支持的格式/);
});

test("PUT /api/config 修改默认语种并持久化", async () => {
  const response = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defaultLocale: "ko_KR" })
  });
  assert.equal(response.status, 200);
  const { json } = await get("/api/config");
  assert.equal(json.config.defaultLocale, "ko_KR");
  const saved = JSON.parse(await readFile(process.env.LEAGUE_VOICE_CONFIG!));
  assert.equal(saved.defaultLocale, "ko_KR");
  await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defaultLocale: "ja_JP" })
  });
});

test("外服 HTTP 全链路：确认路径与区服、预检、开启语音/文字、还原", async () => {
  const saved = await loadConfig();
  try {
    for (const locale of ["ko_KR", "zh_TW", "fr_FR", "en_US"]) {
      const league = path.join(fixture!.root, "foreign", locale, "Riot Games", "League of Legends");
      const final = path.join(league, "Game", "DATA", "FINAL");
      await writeFile(path.join(league, "LeagueClient.exe"), "CLIENT");
      await writeFile(path.join(league, "Game", "League of Legends.exe"), "GAME");
      const yaml = path.join(league, "Config", "LeagueClientSettings.yaml");
      await writeFile(yaml, `install:\n  globals:\n    locale: ${locale}\n`);
      const other = locale === "en_US" ? "zh_CN" : "en_US";
      for (const code of [locale, other]) {
        for (const name of ["Champions/Ahri", "Maps/Shipping/Map11", "Localized/Global"]) {
          await writeFile(path.join(final, `${name}.${code}.wad.client`), `${code}:${name}`);
        }
      }
      const configured = await fetch(`${base}/api/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leaguePath: league, baseLocale: "", ui: { region: "global" } }) });
      assert.equal(configured.status, 200);
      const client = await get("/api/client");
      assert.equal(client.json.base_locale, locale);
      assert.equal(client.json.region, "global");
      const plan = await post("/api/plan", { locale: "ja_JP", modules: ["ingame_voice", "ingame_lang"] });
      assert.equal(plan.json.plan.ok, true, JSON.stringify(plan.json.plan.blockers));
      const apply = await post("/api/apply", { locale: "ja_JP", modules: ["ingame_voice", "ingame_lang"], restartClient: false });
      const done = await waitTask(apply.json.task.id);
      assert.equal(done.task.status, "succeeded", JSON.stringify(done.result));
      assert.equal(await readFile(path.join(final, `Champions/Ahri.${locale}.wad.client`)), "ja_JP-Ahri");
      assert.equal(await readFile(path.join(final, `Localized/Global.${locale}.wad.client`)), "ja_JP-LANG");
      assert.equal(await readFile(path.join(final, `Champions/Ahri.${other}.wad.client`)), `${other}:Champions/Ahri`);
      const restore = await post("/api/restore", { restartClient: false });
      assert.equal((await waitTask(restore.json.task.id)).task.status, "succeeded");
      assert.equal(await readFile(path.join(final, `Champions/Ahri.${locale}.wad.client`)), `${locale}:Champions/Ahri`);
      assert.equal(await readFile(path.join(final, `Localized/Global.${locale}.wad.client`)), `${locale}:Localized/Global`);
      assert.equal(await readFile(yaml), `install:\n  globals:\n    locale: ${locale}\n`);
      const state = await get("/api/state");
      assert.equal(state.json.state.ingame.is_voice_active, false);
      assert.doesNotMatch(state.json.state.ingame.voice, /国服/);
    }
  } finally { await saveConfig(saved); }
});

test("GET /api/events 建立 SSE 连接并推送进度", async () => {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type")), /text\/event-stream/);
  const reader = response.body!.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /: connected/);
  controller.abort();
});

test("静态托管: 前端路由刷新不 404(SPA 兜底), /api 未知路径仍返回 JSON 404", async () => {
  const spa = await fetch(`${base}/some/frontend/route`);
  assert.equal(spa.status, 200);
  assert.match(String(spa.headers.get("content-type")), /text\/html/);
  assert.match(await spa.text(), /语音包/);

  const api404 = await fetch(`${base}/api/not-exist`);
  assert.equal(api404.status, 404);
  const payload = (await api404.json()) as { error?: string };
  assert.equal(payload.error, "not_found");
});

test("品牌图: /brand/ 能取子目录素材(assets/ico/ 里的图标), 越权仍被挡", async () => {
  const icon = await fetch(`${base}/brand/ico/voicepack-icon-512.png`);
  assert.equal(icon.status, 200, "assets/ico 里的图标应该能取到");
  assert.match(String(icon.headers.get("content-type")), /image\/png/);
  const bytes = Buffer.from(await icon.arrayBuffer());
  assert.ok(bytes.length > 1000, "应该是真实的图片");
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG");

  const escape = await fetch(`${base}/brand/ico/..%2F..%2Fconfig.json`);
  const body = await escape.text();
  assert.ok(!body.includes("leaguePath"), "越权路径不能读到文件内容");
  assert.equal((JSON.parse(body) as { ok?: boolean }).ok, false);
});

test("品牌图: 自绘的矢量图能被托管(文字是矢量的, 任何缩放都清晰)", async () => {
  const response = await fetch(`${base}/brand-logo.svg`);
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type")), /image\/svg\+xml/);
  const text = await response.text();
  assert.match(text, /LoLskins/, "品牌英文");
  assert.match(text, /稳定换肤/, "中文要在图里(矢量文字, 不再靠缩放后糊掉的位图)");
  assert.ok(!/Gradient/i.test(text), "不要渐变(用户明确要求纯色)");
  assert.match(text, /<svg/);
});

test("品牌图: /brand/<文件> 直接把软件目录 assets 里的素材发出去(不用复制一份到 web/)", async () => {
  const response = await fetch(`${base}/brand/ChosenLoLskins-logo.png`);
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type")), /image\/png/);
  const buffer = Buffer.from(await response.arrayBuffer());
  assert.ok(buffer.length > 1000, "应返回真实的图片数据");
  assert.equal(buffer.subarray(1, 4).toString("latin1"), "PNG", "文件头应是 PNG");

  const bad = await fetch(`${base}/brand/no-such-file.png`);
  assert.equal(bad.status, 404);
  // 想越出 assets 目录: 必须被挡掉(返回错误的 JSON, 而不是把磁盘文件发出去)
  const traversal = await fetch(`${base}/brand/..%2Fconfig.json`);
  const body = await traversal.text();
  assert.ok(!body.includes("leaguePath"), "绝不能把 config.json 的内容发出去");
  assert.match(String(traversal.headers.get("content-type")), /application\/json/, "越权请求应得到一条错误说明");
  assert.equal((JSON.parse(body) as { ok?: boolean }).ok, false);
});

test("错误处理: 未知任务返回 not_found, 非法 JSON 返回 400", async () => {
  const missing = await get("/api/tasks/not-a-task");
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.error, "not_found");

  const bad = await fetch(`${base}/api/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{ this is not json"
  });
  assert.equal(bad.status, 400);
  const payload = (await bad.json()) as { error?: string };
  assert.equal(payload.error, "bad_json");
});

test("鉴权: 配置了 token 后无令牌请求被拒绝", async () => {
  const guarded = await startApiServer({ host: "127.0.0.1", port: 0, token: "secret-token" });
  const guardedBase = `http://127.0.0.1:${guarded.running.port}`;
  try {
    const denied = await fetch(`${guardedBase}/api/health`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${guardedBase}/api/health`, { headers: { "X-Auth-Token": "secret-token" } });
    assert.equal(allowed.status, 200);
  } finally {
    await guarded.running.close();
  }
});

test("并发保护: 语音任务互斥, 第二个任务被拒绝", async () => {
  const first = await post("/api/plan", { locale: "ja_JP" });
  assert.equal(first.json.ok, true);
  // 直接连发两次 apply: 第一次占住互斥组, 第二次必须被挡下
  const a = await post("/api/apply", { locale: "ja_JP", modules: ["ingame_voice"], restartClient: false });
  const b = await post("/api/apply", { locale: "ja_JP", modules: ["ingame_voice"], restartClient: false });
  assert.equal(a.json.ok, true);
  if (b.json.ok) await waitTask(b.json.task.id);
  else assert.match(b.json.message ?? "", /已有任务在进行中/);
  await waitTask(a.json.task.id);
  await post("/api/restore", { restartClient: false }).then((response) => waitTask(response.json.task.id));
});

test("关闭 API 服务会解除任务和选人事件订阅", async (t) => {
  let taskUnsubscribed = 0;
  let lobbyUnsubscribed = 0;
  const subscribeTask = taskManager.subscribe.bind(taskManager);
  const subscribeLobby = lobbyLive.subscribe.bind(lobbyLive);
  t.mock.method(taskManager, "subscribe", (listener: Parameters<typeof taskManager.subscribe>[0]) => {
    const off = subscribeTask(listener);
    return () => { taskUnsubscribed++; off(); };
  });
  t.mock.method(lobbyLive, "subscribe", (listener: Parameters<typeof lobbyLive.subscribe>[0]) => {
    const off = subscribeLobby(listener);
    return () => { lobbyUnsubscribed++; off(); };
  });
  for (let i = 0; i < 3; i++) {
    const started = await startApiServer({ port: 0 });
    await started.running.close();
  }
  assert.equal(taskUnsubscribed, 3);
  assert.equal(lobbyUnsubscribed, 3);
});

test("server.maxUploadBytes 配置实际约束 API 上传", async () => {
  const saved = await loadConfig();
  await saveConfig({ server: { ...saved.server, maxUploadBytes: 4 } });
  const started = await startApiServer({ port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${started.running.port}/api/packs/import?name=test.zip`, { method: "POST", body: "too-large" });
    assert.equal(response.status, 413);
    assert.equal((await response.json() as any).error, "payload_too_large");
  } finally { await started.running.close(); await saveConfig({ server: saved.server }); }
});
test("提示设置: POST /api/ui/hide-enable-tip 写进配置, /api/state 里读得到", async () => {
  const before = await get("/api/state");
  assert.equal((before.json.state as any).hide_enable_tip, false, "默认应是没有设置过");

  const saved = await post("/api/ui/hide-enable-tip", {});
  assert.equal(saved.json.ok, true);

  const after = await get("/api/state");
  assert.equal((after.json.state as any).hide_enable_tip, true, "设置之后应为 true");
});

});

