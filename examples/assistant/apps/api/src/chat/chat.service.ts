import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { LLM, toolCallMessage } from "../llm/llm.service";
import { MAIN_LLM } from "../llm/llm.types";
import { MemoryService } from "../memory/memory.service";
import { MEMORY_CONFIG, type MemoryConfig } from "../memory/memory.types";
import { userMessageTemplate } from "../prompts";
import { SoulService } from "../soul/soul.service";
import { TodoService } from "../todo/todo.service";
import { SessionService } from "./session.service";

/**
 * 一轮模型调用要用到的东西
 */
interface StepContext {
  messages: ChatCompletionMessageParam[];
  /**
   * 本轮提问原文，检索时作为辅助线索
   */
  hint: string;
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

@Injectable()
export class ChatService implements OnModuleInit {
  constructor(
    @Inject(MAIN_LLM) private llm: LLM,
    @Inject(MEMORY_CONFIG) private config: MemoryConfig,
    private sessions: SessionService,
    private soul: SoulService,
    private memory: MemoryService,
    private todo: TodoService
  ) {}

  onModuleInit() {
    this.soul.init();
    // 用户安静下来了：会话窗口清空，长期记忆借这个空档去消化
    this.sessions.onExpire(() => this.memory.onIdle());
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
  async complete(
    messages: ChatCompletionMessageParam[],
    hint: string,
    signal: AbortSignal,
    onDelta?: (text: string) => void
  ): Promise<string> {
    let answer = "";

    const emit = (text: string) => {
      if (text) {
        answer += text;
        onDelta?.(text);
      }
    };
    const playFiller = () => {
      const { searchFiller } = this.config;
      if (onDelta && searchFiller && !answer) {
        onDelta(searchFiller);
      }
    };

    for (;;) {
      const context: StepContext = {
        messages,
        hint,
        signal,
        stream: !!onDelta,
        emit,
        playFiller,
      };
      const searchedThisRound = await this.stepTools(context);
      if (!searchedThisRound) {
        return answer;
      }
    }
  }

  /**
   * 标准 function calling：模型发起 tool_call，我们执行完把 tool 消息续上
   *
   * 注意：记忆和待办的工具在这里合并声明、按名字 dispatch 到各自的 owner。
   * 检索是本地同步的、待办要落库是异步的，所以统一 await。
   */
  private async stepTools(ctx: StepContext): Promise<boolean> {
    const { messages, signal } = ctx;
    const tools = [...this.memory.tools(), ...this.todo.tools()];
    const options = { signal, ...(tools.length ? { tools } : {}) };
    const result = ctx.stream
      ? await this.llm.chatStream(messages, { ...options, onDelta: ctx.emit })
      : await this.llm.chat(messages, options);
    if (!ctx.stream) {
      ctx.emit(result.content);
    }
    if (!tools.length || !result.toolCalls.length) {
      return false;
    }

    // 只有真发起了记忆检索才播"让我想想"——那一句是为了盖住检索多出来的一秒往返；
    // 待办工具很快，加这个停顿反而奇怪
    if (result.toolCalls.some((c) => c.name === "search_memory")) {
      ctx.playFiller();
    }

    // 每个 tool_call 都必须有一条对应的 tool 消息，否则下一次请求会被服务端打回
    messages.push(toolCallMessage(result));
    const todoNames = new Set(this.todo.tools().map((t) => t.function.name));
    for (const call of result.toolCalls) {
      const content = todoNames.has(call.name)
        ? await this.todo.runTool(call)
        : this.memory.runTool(call, ctx.hint);
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
    return true;
  }

  /**
   * 一轮问答落定：写会话窗口 + 落长期记忆
   *
   * 注意：长期记忆是异步的，不阻塞应答
   *
   * @param conversationId 这一轮属于哪段对话，由调用方在**用户开口时**取好传进来
   */
  remember(sessionId: string, conversationId: string, user: string, assistant: string, speaker?: string) {
    // 被抢话时也把已经生成的部分记进历史，但一个字都没生成就不写了：
    // 上下文里留一条没有回复的提问，下一轮就变成连续两条 user
    if (assistant) {
      this.sessions.append(sessionId, user, assistant);
    }
    // 长期记忆不看有没有回复：用户说的话在 user 消息里，
    // 「记住我对海鲜过敏」刚说完就被抢话，这事照样得记住
    this.memory.onTurn({ sessionId, conversationId, user, assistant, speaker });
  }

  /**
   * 拼装发给大模型的消息
   *
   * 注意：这里不写历史，成功拿到回复后才成对写入，
   * 避免失败的请求把上下文污染掉
   */
  messages(sessionId: string, text: string, speaker?: string): ChatCompletionMessageParam[] {
    return [
      { role: "system", content: this.soul.systemPrompt() },
      ...this.sessions.history(sessionId),
      { role: "user", content: this.userMessage(text, speaker) },
    ];
  }

  /**
   * 提问，前面挂上临期日程（前瞻记忆）
   *
   * 这是唯一保留的自动注入：推送型记忆等不来检索——用户问"今天有什么安排"
   * 模型会去查，但"明天有钢琴课"应该在聊到出游时不查自知。
   * 条目少而具体，不构成注意力污染。
   */
  private userMessage(text: string, speaker?: string): string {
    const scheduleLines = [
      ...this.memory.upcoming().map((e) => `- ${e.dueAt} ${e.content}`),
      ...this.todo.upcoming().map((t) => `- ${(t.dueAt ?? "").slice(0, 16).replace("T", " ")} ${t.content}`),
    ];
    return userMessageTemplate(text, { speaker, scheduleLines });
  }
}
