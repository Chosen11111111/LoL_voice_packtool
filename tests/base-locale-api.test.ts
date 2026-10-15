import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { detectBaseLocale } from "../src/packs/baselocale.ts";
import { clearProcessCache, clearCredentialCache, setClientDirHint } from "../src/core/win/processes.ts";
import { makeTempDir, writeFile } from "./helpers.ts";

async function scenario(t: any, differentInstall: boolean, body: string) {
  const root = await makeTempDir("base-locale-api");
  const leagueDir = path.join(root, "selected");
  const running = differentInstall ? path.join(root, "other") : leagueDir;
  const finalDir = path.join(leagueDir, "Game", "DATA", "FINAL");
  for (const locale of ["en_US", "fr_FR"]) await writeFile(path.join(finalDir, "Champions", `Ahri.${locale}.wad.client`), locale);
  let probes = 0;
  t.mock.method(childProcess, "spawn", () => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    queueMicrotask(() => { child.stdout.end(JSON.stringify([{ Name: "LeagueClientUx.exe", ProcessId: 123, ExecutablePath: path.join(running, "LeagueClientUx.exe"), CommandLine: "--app-port=12345 --remoting-auth-token=test" }])); child.emit("close", 0); });
    return child;
  });
  t.mock.method(https, "request", (options: any, callback: Function) => {
    if (options.path === "/riotclient/region-locale") probes++;
    const request: any = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response: any = new EventEmitter(); response.statusCode = 200;
      callback(response); response.emit("data", Buffer.from(body)); response.emit("end");
    });
    request.destroy = () => {};
    return request;
  });
  syncBuiltinESMExports(); clearProcessCache(); clearCredentialCache(); setClientDirHint(null);
  try { return { info: await detectBaseLocale({ leagueDir, finalDir, fallbackLocale: "en_US" }), probes }; }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); clearProcessCache(); clearCredentialCache(); setClientDirHint(null); }
}

test("不能把另一份运行中客户端的语种用于所选安装", async (t) => {
  const result = await scenario(t, true, '{"locale":"fr_FR"}');
  assert.equal(result.info.source, "ambiguous");
  assert.equal(result.probes, 0);
});

test("同一份安装的接口可补充缺失的设置文件", async (t) => {
  const result = await scenario(t, false, '{"locale":"fr_FR"}');
  assert.equal(result.info.locale, "fr_FR");
  assert.equal(result.probes, 1);
});

test("客户端接口缺少有效 locale 时不能从无关字段猜语种", async (t) => {
  const result = await scenario(t, false, '{"other":"fr_FR","locale":"invalid"}');
  assert.equal(result.info.source, "ambiguous");
});
