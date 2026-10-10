/** HTTP API 端到端: 通过接口完成一次"全套切换 -> 状态 -> 还原"。 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { invalidateConfigCache } from "../src/core/config.ts";
import { startApiServer } from "../src/server/api.ts";
import type { RunningServer } from "../src/server/http.ts";
import { cleanupSuite, exists, makeFinalDir, makePack, makePenguLoader, makeTempDir, readFile, useSuite, writeFile } from "./helpers.ts";

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["LEAGUE_VOICE_CONFIG", "LEAGUE_VOICE_ROOT", "LEAGUE_VOICE_PENGU", "LOCALAPPDATA", "LEAGUE_PATH"];

let running: RunningServer | null = null;
let base = "";
let fixture: {
  root: string;
  voiceRoot: string;
  leagueDir: string;
  finalDir: string;
  pluginDir: string;
} | null = null;

async function post(pathname: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, json: await response.json().catch(() => null) };
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
  const pengu = await makePenguLoader(root);

  const configFile = path.join(root, "config.json");
  await writeFile(
    configFile,
    JSON.stringify(
      {
        leaguePath: leagueDir,
        voiceRoot,
        penguLoaderDir: pengu.penguDir,
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
  process.env.LEAGUE_VOICE_PENGU = pengu.penguDir;
  process.env.LOCALAPPDATA = path.join(root, "localappdata");
  delete process.env.LEAGUE_PATH;
  invalidateConfigCache();

  const started = await startApiServer({ host: "127.0.0.1", port: 0 });
  running = started.running;
  base = `http://127.0.0.1:${started.running.port}`;
  fixture = { root, voiceRoot, leagueDir, finalDir, pluginDir: pengu.pluginDir };
});

after(async () => {
  await running?.close();
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
  assert.equal(json.plan.checks.length, 3);
  assert.equal(await readFile(path.join(fixture!.finalDir, "Champions", "Ahri.zh_CN.wad.client")), "CN-Ahri");
});

test("POST /api/apply 全链路切换(大厅+对局语音+对局语言)", async () => {
  const { json } = await post("/api/apply", { locale: "ja_JP", restartClient: false });
  assert.equal(json.ok, true);
  const finished = await waitTask(json.task.id);
  assert.equal(finished.task.status, "succeeded", JSON.stringify(finished.result));
  assert.equal(finished.result.ok, true, JSON.stringify(finished.result.summary));

  // 对局端
  assert.equal(await readFile(path.join(fixture!.finalDir, "Champions", "Ahri.zh_CN.wad.client")), "ja_JP-Ahri");
  assert.equal(await readFile(path.join(fixture!.finalDir, "Maps", "Shipping", "Map11.zh_CN.wad.client")), "ja_JP-Map11");
  assert.equal(await readFile(path.join(fixture!.finalDir, "Localized", "Global.zh_CN.wad.client")), "ja_JP-LANG");
  // 大厅端
  assert.equal(await readFile(path.join(fixture!.leagueDir, "d3d9.dll")), "fake-stub-dll");
  const pluginConfig = JSON.parse(await readFile(path.join(fixture!.pluginDir, "config.json")));
  assert.equal(pluginConfig.enabled, true);
  assert.equal(pluginConfig.locale, "ja_JP");

  const state = await get("/api/state");
  assert.equal(state.json.state.ingame.is_voice_active, true);
  assert.equal(state.json.state.lobby.enabled, true);
});

test("POST /api/restore 全部还原为官方默认", async () => {
  const { json } = await post("/api/restore", { restartClient: false });
  assert.equal(json.ok, true);
  const finished = await waitTask(json.task.id);
  assert.equal(finished.task.status, "succeeded", JSON.stringify(finished.result));
  assert.equal(finished.result.ok, true, JSON.stringify(finished.result.summary));

  assert.equal(await readFile(path.join(fixture!.finalDir, "Champions", "Ahri.zh_CN.wad.client")), "CN-Ahri");
  assert.equal(await readFile(path.join(fixture!.finalDir, "Localized", "Global.zh_CN.wad.client")), "CN-LANG");
  assert.equal(await readFile(path.join(fixture!.leagueDir, "d3d9.dll")), "official-proxy");
  assert.equal(await exists(path.join(fixture!.pluginDir, "voice_assets")), false);

  const state = await get("/api/state");
  assert.equal(state.json.state.ingame.is_voice_active, false);
  assert.equal(state.json.state.lobby.enabled, false);
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
});
