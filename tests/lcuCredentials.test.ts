/** LCU 凭据解析的自测(纯字符串解析, 不需要客户端)。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLcuCommandLine } from "../src/core/win/processes.ts";

test("国际服: 用 --app-port / --remoting-auth-token", () => {
  const line =
    '"C:\\Riot Games\\League of Legends\\LeagueClientUx.exe" --app-port=51234 --remoting-auth-token=AbC-123_xyz --riotclient-app-port=52000 --riotclient-auth-token=OtherToken --region=EUW';
  const parsed = parseLcuCommandLine(line);
  assert.deepEqual(parsed, { port: "51234", token: "AbC-123_xyz", source: "app-port" });
});

test("国服(TENCENT): 没有 app-port, 回退到 riotclient 端口与令牌", () => {
  const line =
    'e:/wegameapps/英雄联盟/LeagueClient/LeagueClientUx.exe --riotclient-auth-token=pcP2qPWqBACQUVT03bg0Ig --riotclient-app-port=60990 --riotclient-tencent --no-rads --region=TENCENT';
  const parsed = parseLcuCommandLine(line);
  assert.deepEqual(parsed, { port: "60990", token: "pcP2qPWqBACQUVT03bg0Ig", source: "riotclient-app-port" });
});

test("只有端口没有令牌 / 什么都没有 -> null", () => {
  assert.equal(parseLcuCommandLine("LeagueClientUx.exe --app-port=51234"), null);
  assert.equal(parseLcuCommandLine("LeagueClientUx.exe --region=TENCENT"), null);
  assert.equal(parseLcuCommandLine(""), null);
});

test("客户端日志第一行也能解析(国服靠日志拿凭据)", () => {
  const logHead =
    '000000.000|   OKAY| Command line arguments: --riotclient-auth-token=pcP2qPWqBACQUVT03bg0Ig --riotclient-app-port=60990 --riotclient-tencent --region=TENCENT -';
  const parsed = parseLcuCommandLine(logHead);
  assert.equal(parsed?.port, "60990");
  assert.equal(parsed?.source, "riotclient-app-port");
});

test("同时存在两套参数时优先国际服那套", () => {
  const line = "--riotclient-app-port=1 --riotclient-auth-token=A --app-port=2 --remoting-auth-token=B";
  assert.equal(parseLcuCommandLine(line)?.source, "app-port");
});
