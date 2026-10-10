/**
 * LCU(英雄联盟客户端本地 API)访问。
 * 证书是自签的, 因此必须关闭校验; 只连 127.0.0.1。
 */
import https from "node:https";
import { createLogger } from "../logger.ts";
import { isClientRunning, killClientUx, lcuCredentials, type LcuCredentials } from "./processes.ts";

const logger = createLogger("lcu");

export interface LcuResponse {
  status: number;
  body: string;
  ok: boolean;
}

export function lcuAuthHeader(token: string): string {
  return `Basic ${Buffer.from(`riot:${token}`, "utf8").toString("base64")}`;
}

/** 直接调用 LCU 接口。 */
export async function lcuRequest(
  method: string,
  apiPath: string,
  options: { credentials?: LcuCredentials | null; timeoutMs?: number; body?: string } = {}
): Promise<LcuResponse> {
  const credentials = options.credentials ?? (await lcuCredentials());
  if (!credentials) return { status: 0, body: "", ok: false };
  const timeoutMs = options.timeoutMs ?? 8000;
  return new Promise<LcuResponse>((resolve) => {
    let settled = false;
    const finish = (payload: LcuResponse) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    const request = https.request(
      {
        host: "127.0.0.1",
        port: Number(credentials.port),
        path: apiPath,
        method,
        headers: {
          Authorization: lcuAuthHeader(credentials.token),
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        rejectUnauthorized: false,
        timeout: timeoutMs
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          finish({ status, body: Buffer.concat(chunks).toString("utf8"), ok: status > 0 && status < 400 });
        });
      }
    );
    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", (error) => {
      logger.debug(`LCU ${method} ${apiPath} 失败: ${error.message}`);
      finish({ status: 0, body: "", ok: false });
    });
    if (options.body) request.write(options.body);
    request.end();
  });
}

export interface RestartResult {
  ok: boolean;
  method: "lcu" | "taskkill" | "none";
  message: string;
}

/** 重启客户端 UX: 优先走 LCU 官方接口, 失败退回结束进程。 */
export async function restartClientUx(): Promise<RestartResult> {
  const response = await lcuRequest("POST", "/riotclient/kill-and-restart-ux", { timeoutMs: 6000 });
  if (response.ok) {
    logger.info("已通过 LCU 触发客户端 UX 重启");
    return { ok: true, method: "lcu", message: "已通过 LCU 接口重启客户端" };
  }
  if (!(await isClientRunning())) {
    return { ok: false, method: "none", message: "客户端未在运行, 无需重启" };
  }
  const killed = await killClientUx();
  if (killed.ok) {
    logger.info(`已结束客户端 UX 进程: ${killed.message}`);
    return { ok: true, method: "taskkill", message: "已结束客户端 UX 进程, 看门狗将自动拉起" };
  }
  return { ok: false, method: "none", message: `重启客户端失败: ${killed.message}` };
}

/** 等待客户端重新起来(用于"改完自动重启生效"的收尾提示)。 */
export async function waitForClientUp(timeoutMs = 60000, intervalMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isClientRunning()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
