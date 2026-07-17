import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { LLM, toolCallMessage, type LLMConfig } from "./llm.js";
import { MemoryManager, type MemoryConfig } from "./memory/manager.js";
import { kMarkerPrefix, kMarkerSuffix, MarkerSniffer } from "./memory/marker.js";
import { SessionStore, type SessionConfig } from "./session.js";
import { Soul } from "./soul.js";

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
   * 灵魂文件：性格、说话风格、边界
   */
  soulFile: string;
  /**
   * 旧版系统提示词（deprecated，建议迁移到 soul.md）
   */
  systemPrompt?: string;
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
  /**
   * 长期记忆配置
   */
  memory: MemoryConfig;
}

interface ChatRequest {
  request_id?: string;
  session_id?: string;
  text?: string;
  stream?: boolean;
  timestamp?: number;
}

/**
 * 一轮模型调用要用到的东西，两种传输方式共用
 */
interface StepContext {
  messages: ChatCompletionMessageParam[];
  /**
   * 本轮提问原文，检索时作为辅助线索
   */
  hint: string;
  /**
   * 这一轮还允不允许检索（到了上限就不允许）
   */
  canSearch: boolean;
  signal: AbortSignal;
  stream: boolean;
  /**
   * 把文本播给用户并记进回复
   */
  emit: (text: string) => void;
  /**
   * 检索前播一句填补话术
   */
  playFiller: () => void;
}

/**
 * 请求体大小上限
 */
const kMaxBodySize = 64 * 1024;

export class AssistantServer {
  private llm: LLM;
  private sessions: SessionStore;
  private soul: Soul;
  private memory: MemoryManager;
  private server?: Server;

  constructor(private config: AssistantConfig) {
    this.llm = new LLM(config.openai);
    this.memory = new MemoryManager(config.memory);
    this.sessions = new SessionStore({
      ...config.session,
      // 用户安静下来了：会话窗口清空，长期记忆借这个空档去消化
      onExpire: () => this.memory.onIdle(),
    });
    this.soul = new Soul({
      soulFile: config.soulFile,
      profileFile: config.memory.profileFile,
      systemPrompt: config.systemPrompt,
      memoryEnabled: config.memory.enabled,
      recallTransport: config.memory.recallTransport,
    });
  }

  async start() {
    const { host, port, apiKey } = this.config;
    this.soul.init();
    await this.memory.start();

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
    console.log(`   灵魂: ${this.config.soulFile}`);
    console.log(
      `   会话: 最多 ${this.config.session.maxTurns} 轮，` +
        `闲置 ${this.config.session.ttl / 1000} 秒算聊完（纯内存，重启即清空）`
    );
    if (this.memory.enabled) {
      console.log(`   记忆: ${this.config.memory.file}（已载入 ${this.memory.size} 条）`);
      console.log(
        `   画像: ${this.config.memory.profileFile}` +
          `（每轮对话结束时炼一版，另每天 ${this.config.memory.consolidateAt} 兜底）`
      );
    } else {
      console.log("   记忆: 已关闭（MEMORY_ENABLED=false）");
    }
    if (this.config.systemPrompt) {
      console.warn("⚠️ ASSISTANT_SYSTEM_PROMPT 已废弃，它会覆盖灵魂文件，建议改用 soul.md");
    }
    if (!apiKey) {
      console.warn("⚠️ 未配置 ASSISTANT_API_KEY，任何人都能调用本服务");
    }
  }

  async stop() {
    const { server } = this;
    this.server = undefined;
    this.memory.stop();
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

    const authorized = !this.config.apiKey ||
      req.headers.authorization === `Bearer ${this.config.apiKey}`;

    // 记忆是给人看的：直接改文件之外，也留一个只读接口方便排查
    if (req.method === "GET" && req.url === "/memories") {
      if (!authorized) {
        return json(res, 401, { error: "unauthorized" });
      }
      return json(res, 200, {
        enabled: this.memory.enabled,
        profile: this.soul.profileText(),
        memories: this.memory.list(),
      });
    }

    // 手动触发一次巩固：平时它是天级后台跑的，排查和验收时等不起
    if (req.method === "POST" && req.url === "/memories/consolidate") {
      if (!authorized) {
        return json(res, 401, { error: "unauthorized" });
      }
      if (!this.memory.enabled) {
        return json(res, 409, { error: "memory disabled" });
      }
      const ok = await this.memory.consolidateNow();
      return json(res, 200, {
        ok,
        profile: this.soul.profileText(),
        memories: this.memory.list(),
      });
    }

    if (req.method !== "POST" || req.url !== "/chat") {
      return json(res, 404, { error: "not found" });
    }

    if (!authorized) {
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

    // 清空长期记忆：不可逆，所以要精确匹配整句，且执行前自动备份。
    // 放在会话重置前面：两者语义不同，长期记忆的清空优先级更高
    if (this.memory.isWipeCommand(text)) {
      await this.memory.wipe();
      return this.replyText(res, !!body.stream, this.config.memory.wipeText);
    }

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
    let answer = "";
    try {
      answer = await this.complete(this.messages(sessionId, text), text, signal);
      console.log(`🤖 [${sessionId}] ${answer}`);
      json(res, 200, { text: answer });
    } catch (e) {
      if (!signal.aborted) {
        console.error("❌ 大模型调用失败", e);
        // 业务错误也返回 200 + 友好话术，比让 migpt 播报通用兜底话术效果好
        json(res, 200, { text: this.config.errorText });
      }
    }
    this.remember(sessionId, text, answer);
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

    // 注意：这里自己累加，而不是接 complete() 的返回值——被抢话时它会抛出，
    // 返回值就没了，已经播出去的那半句也跟着丢了
    let answer = "";
    try {
      await this.complete(this.messages(sessionId, text), text, signal, (delta) => {
        answer += delta;
        sse(res, "delta", { text: delta });
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

    this.remember(sessionId, text, answer);
  }

  /**
   * 调用大模型，需要时在服务内部完成 search_memory 工具循环
   *
   * 注意：对外仍然只是一条普通的 SSE 流，/chat 协议一个字都没变——
   * 工具消息不出这个方法。
   *
   * @param hint 本轮提问原文，检索时作为辅助线索
   * @param onDelta 传了就走流式，不传就一次性返回
   * @returns 模型生成的完整回复（不含填补话术）
   */
  private async complete(
    messages: ChatCompletionMessageParam[],
    hint: string,
    signal: AbortSignal,
    onDelta?: (text: string) => void
  ): Promise<string> {
    const { searchMaxCalls, recallTransport } = this.config.memory;
    let answer = "";
    // 数的是"带检索的模型往返次数"，不是工具调用条数：模型可能在一次回复里
    // 并行查好几个词（"车牌号"+"生日"+"手机号"），那也只是一次往返。
    // 真正要防的是它查完再查的循环，而检索本身是本地的，不要钱
    let searched = 0;

    const emit = (text: string) => {
      if (text) {
        answer += text;
        onDelta?.(text);
      }
    };
    const playFiller = () => {
      const { searchFiller } = this.config.memory;
      // 检索加二次调用要花一两秒。语音场景里干等着像是服务卡死了，
      // 先说句"让我想想"，这个停顿听起来就成了在回忆。
      // 注意：只播不记——这不是模型说的话，不该进历史
      if (onDelta && searchFiller && !answer) {
        onDelta(searchFiller);
      }
    };

    for (;;) {
      const context: StepContext = {
        messages,
        hint,
        // 到了上限就不再给检索的机会，逼模型作答
        canSearch: this.memory.enabled && searched < searchMaxCalls,
        signal,
        stream: !!onDelta,
        emit,
        playFiller,
      };
      const searchedThisRound =
        recallTransport === "marker" ? await this.stepMarker(context) : await this.stepTools(context);
      if (!searchedThisRound) {
        return answer;
      }
      searched++;
    }
  }

  /**
   * 标准 function calling：模型发起 tool_call，我们查完把 tool 消息续上
   */
  private async stepTools(ctx: StepContext): Promise<boolean> {
    const { messages, canSearch, signal } = ctx;
    const options = { signal, ...(canSearch ? { tools: this.memory.tools() } : {}) };
    const result = ctx.stream
      ? await this.llm.chatStream(messages, { ...options, onDelta: ctx.emit })
      : await this.llm.chat(messages, options);
    if (!ctx.stream) {
      ctx.emit(result.content);
    }
    if (!canSearch || !result.toolCalls.length) {
      return false;
    }

    ctx.playFiller();

    // 每个 tool_call 都必须有一条对应的 tool 消息，否则下一次请求会被服务端打回
    messages.push(toolCallMessage(result));
    for (const call of result.toolCalls) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: this.memory.runTool(call, ctx.hint),
      });
    }
    return true;
  }

  /**
   * 文本标记协议：模型第一行输出 <搜记忆:词>，我们嗅出来、拦下、查完再让它作答
   *
   * 注意：语义和 stepTools 完全一样，换的只是"模型怎么告诉我它想查"这一层。
   * 检索执行器、填补话术、次数上限全都复用。
   */
  private async stepMarker(ctx: StepContext): Promise<boolean> {
    const { messages, canSearch, signal } = ctx;
    const sniffer = canSearch ? new MarkerSniffer() : undefined;

    const result = ctx.stream
      ? await this.llm.chatStream(messages, {
          signal,
          onDelta: (delta) => ctx.emit(sniffer ? sniffer.push(delta) : delta),
        })
      : await this.llm.chat(messages, { signal });

    if (!ctx.stream) {
      // 非流式：整段喂给嗅探器，它会把标记吞掉、把正常回答原样吐回来
      ctx.emit(sniffer ? sniffer.push(result.content) : result.content);
    }
    if (sniffer) {
      ctx.emit(sniffer.flush());
    }

    const query = sniffer?.query;
    if (!query) {
      return false;
    }

    ctx.playFiller();

    // 没有 tool 消息可用，就把这一问一答摆成模型看得懂的样子
    messages.push({ role: "assistant", content: `${kMarkerPrefix}${query}${kMarkerSuffix}` });
    messages.push({
      role: "user",
      content: `【记忆检索结果】\n${this.memory.search(query, ctx.hint)}\n\n请根据以上记忆回答刚才的问题，不要再输出检索标记。`,
    });
    return true;
  }

  /**
   * 一轮问答落定：写会话窗口 + 落长期记忆
   *
   * 注意：长期记忆是异步的，不阻塞应答
   */
  private remember(sessionId: string, user: string, assistant: string) {
    // 被抢话时也把已经生成的部分记进历史，但一个字都没生成就不写了：
    // 上下文里留一条没有回复的提问，下一轮就变成连续两条 user
    if (assistant) {
      this.sessions.append(sessionId, user, assistant);
    }
    // 长期记忆不看有没有回复：用户说的话在 user 消息里，
    // 「记住我对海鲜过敏」刚说完就被抢话，这事照样得记住
    this.memory.onTurn({ sessionId, user, assistant });
  }

  /**
   * 拼装发给大模型的消息
   *
   * 注意：这里不写历史，成功拿到回复后才成对写入，
   * 避免失败的请求把上下文污染掉
   */
  private messages(sessionId: string, text: string): ChatCompletionMessageParam[] {
    return [
      { role: "system", content: this.soul.systemPrompt() },
      ...this.sessions.history(sessionId),
      { role: "user", content: this.userMessage(text) },
    ];
  }

  /**
   * 提问，前面挂上临期日程（前瞻记忆）
   *
   * 这是唯一保留的自动注入：推送型记忆等不来检索——用户问"今天有什么安排"
   * 模型会去查，但"明天有钢琴课"应该在聊到出游时不查自知。
   * 条目少而具体，不构成注意力污染。
   */
  private userMessage(text: string): string {
    const upcoming = this.memory.upcoming();
    if (!upcoming.length) {
      return text;
    }
    const list = upcoming.map((e) => `- ${e.dueAt} ${e.content}`).join("\n");
    return `【接下来几天的安排】\n${list}\n\n【用户说】${text}`;
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
