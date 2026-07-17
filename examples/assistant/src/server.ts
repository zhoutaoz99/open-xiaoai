import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { LLM, type LLMConfig } from "./llm.js";
import { SessionStore, type SessionConfig } from "./session.js";

export interface AssistantConfig {
  /**
   * 服务监听的端口
   */
  port: number;
  /**
   * 服务监听的地址
   *
   * 注意：在 Docker 里运行时必须是 0.0.0.0，否则容器外访问不到
   */
  host: string;
  /**
   * API 密钥，需要和 migpt 的 AGENT_API_KEY 一致
   *
   * 注意：未配置时不校验
   */
  apiKey?: string;
  /**
   * 系统提示词
   */
  systemPrompt: string;
  /**
   * 调用大模型失败时的兜底话术
   */
  errorText: string;
  /**
   * 命中这些关键词时清空上下文
   */
  resetKeywords: string[];
  /**
   * 清空上下文后的回复话术
   */
  resetText: string;
  /**
   * 大模型服务配置
   */
  openai: LLMConfig;
  /**
   * 会话上下文配置
   */
  session: SessionConfig;
}

interface ChatRequest {
  request_id?: string;
  session_id?: string;
  text?: string;
  stream?: boolean;
  timestamp?: number;
}

/**
 * 请求体大小上限
 */
const kMaxBodySize = 64 * 1024;

export class AssistantServer {
  private llm: LLM;
  private sessions: SessionStore;
  private server?: Server;

  constructor(private config: AssistantConfig) {
    this.llm = new LLM(config.openai);
    this.sessions = new SessionStore(config.session);
  }

  async start() {
    const { host, port, apiKey } = this.config;
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        console.error("❌ 处理请求失败", e);
        if (!res.headersSent) {
          json(res, 500, { error: "internal error" });
        } else {
          res.end();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });

    this.server = server;
    console.log(`✅ 外部对话服务已启动: http://${host}:${port}`);
    console.log(`   模型: ${this.config.openai.model}`);
    console.log(`   记忆: ${this.config.session.maxTurns} 轮（纯内存，重启即清空）`);
    if (!apiKey) {
      console.warn("⚠️ 未配置 ASSISTANT_API_KEY，任何人都能调用本服务");
    }
  }

  async stop() {
    const { server } = this;
    this.server = undefined;
    if (!server) {
      return;
    }
    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { status: "ok" });
    }

    if (req.method !== "POST" || req.url !== "/chat") {
      return json(res, 404, { error: "not found" });
    }

    const { apiKey } = this.config;
    if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
      return json(res, 401, { error: "unauthorized" });
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch (_) {
      return json(res, 413, { error: "body too large" });
    }

    let body: ChatRequest;
    try {
      body = JSON.parse(raw);
    } catch (_) {
      return json(res, 400, { error: "invalid json" });
    }

    const sessionId = body.session_id;
    const text = body.text?.trim();
    if (!sessionId || !text) {
      return json(res, 400, { error: "session_id and text are required" });
    }

    console.log(`🔥 [${sessionId}] ${text}`);

    if (this.config.resetKeywords.some((k) => text.startsWith(k))) {
      this.sessions.reset(sessionId);
      console.log(`🧹 [${sessionId}] 已清空上下文`);
      return this.replyText(res, !!body.stream, this.config.resetText);
    }

    // migpt 抢话时会断开连接，这里据此中断大模型请求
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) {
        controller.abort();
      }
    });

    await this.sessions.lock(sessionId, () =>
      body.stream
        ? this.chatStream(res, sessionId, text, controller.signal)
        : this.chatOnce(res, sessionId, text, controller.signal)
    );
  }

  private async chatOnce(
    res: ServerResponse,
    sessionId: string,
    text: string,
    signal: AbortSignal
  ) {
    try {
      const answer = await this.llm.chat(this.messages(sessionId, text), {
        signal,
      });
      if (answer) {
        this.sessions.append(sessionId, text, answer);
      }
      console.log(`🤖 [${sessionId}] ${answer}`);
      json(res, 200, { text: answer });
    } catch (e) {
      if (signal.aborted) {
        return;
      }
      console.error("❌ 大模型调用失败", e);
      // 业务错误也返回 200 + 友好话术，比让 migpt 播报通用兜底话术效果好
      json(res, 200, { text: this.config.errorText });
    }
  }

  private async chatStream(
    res: ServerResponse,
    sessionId: string,
    text: string,
    signal: AbortSignal
  ) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let answer = "";
    try {
      await this.llm.chatStream(this.messages(sessionId, text), {
        signal,
        onDelta: (delta) => {
          answer += delta;
          sse(res, "delta", { text: delta });
        },
      });
      sse(res, "done", {});
      res.end();
      console.log(`🤖 [${sessionId}] ${answer}`);
    } catch (e) {
      if (signal.aborted) {
        console.log(`⏹️ [${sessionId}] 用户抢话，已中断`);
      } else {
        console.error("❌ 大模型调用失败", e);
        sse(res, "error", {
          message: e instanceof Error ? e.message : String(e),
          text: this.config.errorText,
        });
        res.end();
      }
    }

    // 被抢话时也把已经生成的部分记进历史，
    // 否则上下文里会留下一条没有回复的提问，下一轮变成连续两条 user
    if (answer) {
      this.sessions.append(sessionId, text, answer);
    }
  }

  /**
   * 拼装发给大模型的消息
   *
   * 注意：这里不写历史，成功拿到回复后才成对写入，
   * 避免失败的请求把上下文污染掉
   */
  private messages(sessionId: string, text: string): ChatCompletionMessageParam[] {
    return [
      { role: "system", content: this.config.systemPrompt },
      ...this.sessions.history(sessionId),
      { role: "user", content: text },
    ];
  }

  /**
   * 直接回一句固定话术，兼容流式和非流式
   */
  private replyText(res: ServerResponse, stream: boolean, text: string) {
    if (!stream) {
      return json(res, 200, { text });
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    sse(res, "delta", { text });
    sse(res, "done", {});
    res.end();
  }
}

function sse(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function json(res: ServerResponse, code: number, data: unknown) {
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
