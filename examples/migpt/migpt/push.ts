import { deepMerge } from "@mi-gpt/utils";
import { jsonDecode } from "@mi-gpt/utils/parse";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { OpenXiaoAISpeaker } from "./speaker.js";

export interface PushConfig {
  /**
   * 推送服务监听的端口
   *
   * 注意：未配置时不会启动推送服务
   */
  port?: number;
  /**
   * 推送服务监听的地址
   *
   * 注意：在 Docker 里运行时必须是 0.0.0.0，否则容器外访问不到
   */
  host?: string;
  /**
   * API 密钥
   *
   * 注意：未配置时不校验，同网络下任何人都能让音箱说话
   */
  apiKey?: string;
}

const kDefaultPushConfig: PushConfig = {
  host: "0.0.0.0",
};

/**
 * 请求体大小上限
 */
const kMaxBodySize = 64 * 1024;

class PushManager {
  private config?: PushConfig;
  private server?: Server;

  /**
   * 是否已开启提醒推送服务
   */
  get enabled() {
    return this.server !== undefined;
  }

  async start(config?: PushConfig) {
    const merged: PushConfig = deepMerge(kDefaultPushConfig, config);
    if (!merged.port) {
      return;
    }
    this.config = merged;

    const server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        console.error("❌ 处理推送请求失败", e);
        reply(res, 500, { ok: false, error: "internal error" });
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(merged.port, merged.host, resolve);
      });
    } catch (e) {
      console.error(`❌ 提醒推送服务启动失败（${merged.host}:${merged.port}）`, e);
      return;
    }

    this.server = server;
    console.log(`✅ 提醒推送服务已启动: ${merged.host}:${merged.port}`);
    if (!merged.apiKey) {
      console.warn(
        "⚠️ 提醒推送服务未配置密钥，同网络下任何人都能让音箱说话"
      );
    }
  }

  async stop() {
    const { server } = this;
    this.server = undefined;
    if (!server) {
      return;
    }
    // 不主动断开空闲的 keep-alive 连接的话，close() 会一直等它们超时
    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "GET" && req.url === "/health") {
      return reply(res, 200, { status: "ok" });
    }

    if (req.method !== "POST" || req.url !== "/push") {
      return reply(res, 404, { ok: false, error: "not found" });
    }

    const { apiKey } = this.config ?? {};
    if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
      return reply(res, 401, { ok: false, error: "unauthorized" });
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch (_) {
      return reply(res, 413, { ok: false, error: "body too large" });
    }

    const body = jsonDecode<{ text?: string; url?: string }>(raw);
    if (!body) {
      return reply(res, 400, { ok: false, error: "invalid json" });
    }

    const { text, url } = body;
    if (!text && !url) {
      return reply(res, 400, { ok: false, error: "text or url is required" });
    }

    console.log(`🔔 ${url || text}`);
    // 先应答，播报在后台排队进行，不让外部服务干等
    reply(res, 202, { ok: true });
    this.play(text, url);
  }

  private async play(text?: string, url?: string) {
    const success = await OpenXiaoAISpeaker.play({ text, url, blocking: true });
    if (!success) {
      console.error("❌ 提醒播报失败，请检查音箱是否在线");
    }
  }
}

function reply(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    let done = false;
    req.on("data", (chunk) => {
      if (done) {
        return;
      }
      body += chunk;
      if (body.length > kMaxBodySize) {
        done = true;
        // 只是停止接收，不能 destroy，否则 413 应答还没写出去连接就断了
        req.pause();
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve(body);
      }
    });
    req.on("error", (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

export const Push = new PushManager();
