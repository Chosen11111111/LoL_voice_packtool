import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir } from "./helpers.ts";

async function launch(home: string, file: string) {
  const entry = new URL("../src/server/api.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { startApiServer } from ${JSON.stringify(entry)};
    const { running } = await startApiServer({ host: "127.0.0.1", port: 0 });
    process.send({ port: running.port });
    process.on("message", async () => { await running.close(); process.exit(0); });
  `], {
    env: { ...process.env, LEAGUE_VOICE_HOME: home, LEAGUE_VOICE_CONFIG: file },
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  let diagnostic = "";
  child.stderr?.on("data", (data) => { diagnostic += data; });
  try {
    const message = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("服务启动超时：" + diagnostic)), 10000);
      child.once("message", (value) => { clearTimeout(timer); resolve(value); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`服务退出 ${code}：${diagnostic}`)); });
    });
    return {
      base: `http://127.0.0.1:${message.port}`,
      pid: child.pid,
      close: async () => { const closed = once(child, "exit"); child.send("close"); await closed; }
    };
  } catch (error) { child.kill(); throw error; }
}

test("HTTP 写入配置后完全退出进程，新进程从同一文件恢复所有窗口设置", async () => {
  const home = await makeTempDir("config-process-restart");
  const file = path.join(home, "settings", "config.json");
  let server = await launch(home, file);
  try {
    // 未显式写入的字段按默认值落盘(voiceDelayMs 默认 1000, lastApplied 默认 null)
    const ui = {
      selectedLocale: "ko_KR",
      modules: ["lobby_voice"],
      volume: 0,
      followClient: false,
      voiceDelayMs: 1000,
      lastApplied: null,

      hideEnableTip: null,


      hideTrayTip: null,
      region: "global"
    };
    const response = await fetch(`${server.base}/api/config`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ui, leaguePath: "D:\\SavedLeague" })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).ui, ui);
    const pid = server.pid;
    await server.close();
    server = await launch(home, file);
    assert.notEqual(server.pid, pid);
    const result = await (await fetch(`${server.base}/api/config`)).json() as any;
    assert.equal(result.path, file);
    assert.equal(result.config.leaguePath, "D:\\SavedLeague");
    assert.deepEqual(result.config.ui, ui);
  } finally { await server.close(); }
});
