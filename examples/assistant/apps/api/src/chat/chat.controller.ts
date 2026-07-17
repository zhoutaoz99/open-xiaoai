import { BadRequestException, Body, Controller, Inject, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { ApiKeyGuard } from "../api-key.guard";
import { MemoryService } from "../memory/memory.service";
import { MEMORY_CONFIG, type MemoryConfig } from "../memory/memory.types";
import { ChatService } from "./chat.service";
import { CHAT_CONFIG, type ChatConfig, type ChatRequest } from "./chat.types";
import { SessionService } from "./session.service";

/**
 * 音箱走的那条路
 *
 * 注意：请求和响应格式和 v1 一模一样，见 examples/migpt/PROTOCOL.md——
 * 记忆检索的工具调用、tool 消息、二次请求全在服务内部闭环，
 * migpt 只看到一条正常的 SSE 文本流。
 *
 * 这里用 @Res() 直接拿原始响应对象自己写 SSE，而不是 Nest 的 @Sse()：
 * @Sse() 要求返回一个 Observable 并由它来决定事件格式，
 * 而我们的事件名和字段是和 migpt 约定死的，不能让框架改一个字。
 */
@Controller("chat")
@UseGuards(ApiKeyGuard)
export class ChatController {
  constructor(
    @Inject(CHAT_CONFIG) private config: ChatConfig,
    @Inject(MEMORY_CONFIG) private memoryConfig: MemoryConfig,
    private chat: ChatService,
    private sessions: SessionService,
    private memory: MemoryService
  ) {}

  @Post()
  async handle(@Body() body: ChatRequest, @Res() res: Response) {
    const sessionId = body.session_id;
    const text = body.text?.trim();
    if (!sessionId || !text) {
      throw new BadRequestException("session_id and text are required");
    }

    console.log(`🔥 [${sessionId}] ${text}`);

    // 清空长期记忆：不可逆，所以要精确匹配整句，且执行前自动备份。
    // 放在会话重置前面：两者语义不同，长期记忆的清空优先级更高
    if (this.memory.isWipeCommand(text)) {
      await this.memory.wipe();
      return replyText(res, !!body.stream, this.memoryConfig.wipeText);
    }

    if (this.config.resetKeywords.some((k) => text.startsWith(k))) {
      this.sessions.reset(sessionId);
      console.log(`🧹 [${sessionId}] 已清空上下文`);
      return replyText(res, !!body.stream, this.config.resetText);
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
    res: Response,
    sessionId: string,
    text: string,
    signal: AbortSignal
  ) {
    // 在用户开口这一刻就把段定下来，别等答完再问「现在是哪一段」——
    // 大模型可能跑得比 TTL 还久，那时会话窗口已经过期重建，
    // 这一轮就会被算进一段它根本不属于的新对话
    const conversationId = this.sessions.conversationId(sessionId);

    let answer = "";
    try {
      answer = await this.chat.complete(this.chat.messages(sessionId, text), text, signal);
      console.log(`🤖 [${sessionId}] ${answer}`);
      res.json({ text: answer });
    } catch (e) {
      if (!signal.aborted) {
        console.error("❌ 大模型调用失败", e);
        // 业务错误也返回 200 + 友好话术，比让 migpt 播报通用兜底话术效果好
        res.json({ text: this.config.errorText });
      }
    }
    this.chat.remember(sessionId, conversationId, text, answer);
  }

  private async chatStream(
    res: Response,
    sessionId: string,
    text: string,
    signal: AbortSignal
  ) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // 同 chatOnce：段在用户开口时就定了，不能等答完再取
    const conversationId = this.sessions.conversationId(sessionId);

    // 注意：这里自己累加，而不是接 complete() 的返回值——被抢话时它会抛出，
    // 返回值就没了，已经播出去的那半句也跟着丢了
    let answer = "";
    try {
      await this.chat.complete(this.chat.messages(sessionId, text), text, signal, (delta) => {
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

    this.chat.remember(sessionId, conversationId, text, answer);
  }
}

function sse(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * 直接回一句固定话术，兼容流式和非流式
 */
function replyText(res: Response, stream: boolean, text: string) {
  if (!stream) {
    res.json({ text });
    return;
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
