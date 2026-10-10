/** LCU 凭据解析的自测(纯字符串解析, 不需要客户端)。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLcuCandidates, parseLcuCommandLine, pickVerifiedCredentials } from "../src/core/win/processes.ts";

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

test("国服真实日志: 'Cef CommandLine' 行才是真正的 LCU(app-port=61193), 第 8 行只有 riotclient", () => {
  // 这是国服客户端 LeagueClientUx.log 的真实结构: 第 8 行(Command line arguments)只有 riotclient 那对,
  // 真正的 --app-port/--remoting-auth-token 在第 20 行(Cef CommandLine)里。
  const head = [
    "000000.000| ALWAYS| Logging started at 2026-10-10T23:21:28.334",
    "000000.000|   OKAY| Command line arguments: --riotclient-auth-token=pcP2qPWqBACQUVT03bg0Ig --riotclient-app-port=60990 --riotclient-tencent --no-rads --region=TENCENT --locale=zh_CN",
    '000000.003| ALWAYS| Cef CommandLine: e:/wegameapps/英雄联盟/LeagueClient/LeagueClientUx.exe --app-name=LeagueClient --app-pid=17940 --app-port=61193 --crash-environment=tj101 --remoting-auth-token=CrFvZjF4thObC6o6HUXeng --region=TENCENT'
  ].join("\n");

  const candidates = parseLcuCandidates(head);
  assert.equal(candidates[0]!.source, "app-port", "app-port 必须排第一");
  assert.equal(candidates[0]!.port, "61193");
  assert.equal(candidates[0]!.token, "CrFvZjF4thObC6o6HUXeng");
  // riotclient 那对只作为后备候选
  assert.equal(candidates.some((item) => item.source === "riotclient-app-port"), true);
});

test("验证: 只有探测通过的候选才会被采用(Riot 客户端端口会被跳过)", async () => {
  const riot = { port: "60990", token: "T1", protocol: "https", source: "riotclient-app-port" } as const;
  const league = { port: "61193", token: "T2", protocol: "https", source: "app-port" } as const;
  // 探测函数: 只有 61193 才算英雄联盟 LCU
  const probed = await pickVerifiedCredentials([riot, league], async (creds) => creds.port === "61193");
  assert.equal(probed?.port, "61193");

  const none = await pickVerifiedCredentials([riot], async () => false);
  assert.equal(none, null);
});

test("验证顺序: 第一个通过的就被采用(不会白试后面的)", async () => {
  const first = { port: "1", token: "A", protocol: "https", source: "app-port" } as const;
  const second = { port: "2", token: "B", protocol: "https", source: "app-port" } as const;
  const calls: string[] = [];
  const picked = await pickVerifiedCredentials([first, second], async (creds) => {
    calls.push(creds.port);
    return creds.port === "1";
  });
  assert.equal(picked?.port, "1");
  assert.deepEqual(calls, ["1"]);
});
