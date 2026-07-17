import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { LLM, toolCallMessage } from "../llm/llm.service";
import { MAIN_LLM } from "../llm/llm.types";
import { kMarkerPrefix, kMarkerSuffix, MarkerSniffer } from "../memory/marker";
import { MemoryService } from "../memory/memory.service";
import { MEMORY_CONFIG, type MemoryConfig } from "../memory/memory.types";
import { SoulService } from "../soul/soul.service";
import { SessionService } from "./session.service";

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

@Injectable()
export class ChatService implements OnModuleInit {
  constructor(
    @Inject(MAIN_LLM) private llm: LLM,
    @Inject(MEMORY_CONFIG) private config: MemoryConfig,
    private sessions: SessionService,
    private soul: SoulService,
    private memory: MemoryService
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
    const { searchMaxCalls, recallTransport } = this.config;
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
      const { searchFiller } = this.config;
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
        recallTransport === "marker"
          ? await this.stepMarker(context)
          : await this.stepTools(context);
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
   *
   * @param conversationId 这一轮属于哪段对话，由调用方在**用户开口时**取好传进来
   */
  remember(sessionId: string, conversationId: string, user: string, assistant: string) {
    // 被抢话时也把已经生成的部分记进历史，但一个字都没生成就不写了：
    // 上下文里留一条没有回复的提问，下一轮就变成连续两条 user
    if (assistant) {
      this.sessions.append(sessionId, user, assistant);
    }
    // 长期记忆不看有没有回复：用户说的话在 user 消息里，
    // 「记住我对海鲜过敏」刚说完就被抢话，这事照样得记住
    this.memory.onTurn({ sessionId, conversationId, user, assistant });
  }

  /**
   * 拼装发给大模型的消息
   *
   * 注意：这里不写历史，成功拿到回复后才成对写入，
   * 避免失败的请求把上下文污染掉
   */
  messages(sessionId: string, text: string): ChatCompletionMessageParam[] {
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
}
