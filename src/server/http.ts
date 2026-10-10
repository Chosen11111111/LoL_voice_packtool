/** 零依赖 HTTP 路由(路径参数 / JSON body / SSE / 可选静态目录)。 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../core/logger.ts";

const logger = createLogger("http");

export interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  rawBody: string;
  contentType: string;
  /** 二进制上传时落盘的临时文件(处理完由服务端清理)。 */
  rawFile?: string;
}

export type Handler = (context: RequestContext) => Promise<unknown> | unknown;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  /** 原始请求体路由: 二进制直接落盘(用于上传压缩包), 不按 JSON 解析。 */
  raw?: boolean;
}

export interface SseClient {
  send: (event: string, data: unknown) => void;
  close: () => void;
  closed: boolean;
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly sseClients = new Set<SseClient>();

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method: method.toUpperCase(), segments: pattern.split("/").filter(Boolean), handler });
  }

  get(pattern: string, handler: Handler): void {
    this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): void {
    this.add("POST", pattern, handler);
  }

  /** 二进制上传路由(Content-Type 不是 JSON 时把请求体流式写入临时文件)。 */
  postRaw(pattern: string, handler: Handler): void {
    this.routes.push({ method: "POST", segments: pattern.split("/").filter(Boolean), handler, raw: true });
  }

  put(pattern: string, handler: Handler): void {
    this.add("PUT", pattern, handler);
  }

  patch(pattern: string, handler: Handler): void {
    this.add("PATCH", pattern, handler);
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const segments = pathname.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method && route.method !== "ALL") continue;
      if (route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const pattern = route.segments[i]!;
        if (pattern.startsWith(":")) {
          params[pattern.slice(1)] = decodeURIComponent(segments[i]!);
          continue;
        }
        if (pattern !== segments[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return { route, params };
    }
    return null;
  }

  /** 注册 SSE 客户端(进度广播)。 */
  addSseClient(client: SseClient): () => void {
    this.sseClients.add(client);
    return () => this.sseClients.delete(client);
  }

  get sseCount(): number {
    return this.sseClients.size;
  }

  broadcast(event: string, data: unknown): void {
    for (const client of [...this.sseClients]) {
      if (client.closed) {
        this.sseClients.delete(client);
        continue;
      }
      try {
        client.send(event, data);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }
}

export interface ServerOptions {
  host: string;
  port: number;
  token: string;
  router: Router;
  /** 可选静态资源目录(网页 UI)。 */
  staticDir?: string;
  /** 前端路由兜底: 未命中的 GET 页面请求交给 index.html。 */
  spaFallback?: boolean;
  /** 上传体积上限(字节); 0 或未设置 = 不限制。 */
  maxUploadBytes?: number;
  /** 上传临时目录(默认 <cwd>/.tmp/uploads)。 */
  uploadDir?: string;
  bodyLimitBytes?: number;
}

export interface RunningServer {
  server: http.Server;
  port: number;
  host: string;
  close: () => Promise<void>;
}

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store"
  });
  res.end(text);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

async function serveStatic(res: http.ServerResponse, staticDir: string, pathname: string): Promise<boolean> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.join(staticDir, relative);
  if (!target.startsWith(path.resolve(staticDir))) return false;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return false;
    const data = await fs.readFile(target);
    res.writeHead(200, { "Content-Type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream" });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

export async function startHttpServer(options: ServerOptions): Promise<RunningServer> {
  const bodyLimit = options.bodyLimitBytes ?? 1_000_000;

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "content-type, x-auth-token");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, OPTIONS");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // 非回环监听或显式配置了 token 时, 一律校验令牌
      if (options.token) {
        const provided = String(req.headers["x-auth-token"] ?? url.searchParams.get("token") ?? "");
        if (provided !== options.token) {
          jsonResponse(res, 401, { ok: false, error: "unauthorized", message: "缺少或错误的访问令牌" });
          return;
        }
      }

      // SSE: 长连接, 专门处理
      if (url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no"
        });
        res.write(`: connected ${new Date().toISOString()}\n\n`);
        const client: SseClient = {
          closed: false,
          send: (event, data) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          },
          close: () => {
            client.closed = true;
            res.end();
          }
        };
        const remove = options.router.addSseClient(client);
        const ping = setInterval(() => {
          if (client.closed) return;
          res.write(`: ping\n\n`);
        }, 20000);
        req.on("close", () => {
          clearInterval(ping);
          client.closed = true;
          remove();
        });
        return;
      }

      const matched = options.router.match(req.method ?? "GET", url.pathname);
      if (!matched) {
        const isApi = url.pathname.startsWith("/api/");
        if (req.method === "GET" && options.staticDir && !isApi) {
          if (await serveStatic(res, options.staticDir, url.pathname)) return;
          // 交给前端路由(React/Vue 的 history 路由刷新不会 404)
          if (options.spaFallback && (await serveStatic(res, options.staticDir, "/index.html"))) return;
        }
        jsonResponse(res, 404, { ok: false, error: "not_found", message: `未找到接口 ${req.method} ${url.pathname}` });
        return;
      }

      const contentType = String(req.headers["content-type"] ?? "");

      // 二进制上传: 直接落盘, 不进内存(语音包压缩包可能有好几个 GB)
      let rawFile: string | undefined;
      if (matched.route.raw && !contentType.includes("application/json")) {
        const uploadDir = options.uploadDir ?? path.join(process.cwd(), ".tmp", "uploads");
        await fs.mkdir(uploadDir, { recursive: true }).catch(() => undefined);
        rawFile = path.join(uploadDir, `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);
        const limit = options.maxUploadBytes ?? 0;
        let size = 0;
        let tooLarge = false;
        const handle = await fs.open(rawFile, "w");
        try {
          for await (const chunk of req) {
            const buffer = chunk as Buffer;
            size += buffer.length;
            if (limit > 0 && size > limit) {
              tooLarge = true;
              break;
            }
            await handle.write(buffer);
          }
        } finally {
          await handle.close().catch(() => undefined);
        }
        if (tooLarge) {
          await fs.rm(rawFile, { force: true }).catch(() => undefined);
          jsonResponse(res, 413, { ok: false, error: "payload_too_large", message: `上传体积超过上限（${limit} 字节）` });
          return;
        }
        if (size === 0) {
          await fs.rm(rawFile, { force: true }).catch(() => undefined);
          jsonResponse(res, 400, { ok: false, error: "empty_body", message: "没有收到文件内容" });
          return;
        }
      }

      let rawBody = "";
      if (req.method !== "GET" && req.method !== "HEAD" && rawFile === undefined) {
        const chunks: Buffer[] = [];
        let size = 0;
        let overflow = false;
        for await (const chunk of req) {
          const buffer = chunk as Buffer;
          size += buffer.length;
          if (size > bodyLimit) {
            overflow = true;
            break;
          }
          chunks.push(buffer);
        }
        if (overflow) {
          jsonResponse(res, 413, { ok: false, error: "payload_too_large", message: "请求体过大" });
          return;
        }
        rawBody = Buffer.concat(chunks).toString("utf8");
      }

      let body: unknown = null;
      if (rawBody.trim()) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          jsonResponse(res, 400, { ok: false, error: "bad_json", message: "请求体不是合法 JSON" });
          return;
        }
      }

      const context: RequestContext = {
        req,
        res,
        method: req.method ?? "GET",
        url,
        params: matched.params,
        query: url.searchParams,
        body,
        rawBody,
        contentType,
        rawFile
      };

      try {
        const payload = await matched.route.handler(context);
        if (res.writableEnded) return;
        if (payload && typeof payload === "object" && "__raw" in (payload as Record<string, unknown>)) {
          const raw = payload as { status?: number; text?: string; contentType?: string };
          res.writeHead(raw.status ?? 200, { "Content-Type": raw.contentType ?? "text/plain; charset=utf-8" });
          res.end(raw.text ?? "");
          return;
        }
        jsonResponse(res, 200, payload ?? { ok: true });
      } catch (error) {
        const message = String((error as Error).message ?? error);
        logger.warn(`接口异常 ${req.method} ${url.pathname}: ${message}`);
        jsonResponse(res, 500, { ok: false, error: "internal_error", message });
      } finally {
        // 上传的临时文件: 处理器若已把它移交给后台任务会先移走, 这里只清理残留
        if (rawFile) await fs.rm(rawFile, { force: true }).catch(() => undefined);
      }
    })().catch((error) => {
      logger.error(`请求处理失败: ${String((error as Error).message ?? error)}`);
      if (!res.headersSent) jsonResponse(res, 500, { ok: false, error: "internal_error" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  logger.info(`HTTP 服务已启动: http://${options.host}:${port}`);

  return {
    server,
    port,
    host: options.host,
    close: async () => {
      for (const client of (options.router as unknown as { sseClients: Set<SseClient> }).sseClients ?? []) client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
