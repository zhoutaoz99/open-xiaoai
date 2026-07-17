import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ChatOptions, LLMConfig, LLMResult, ToolCall } from "./llm.types";

/**
 * 大模型调用
 *
 * 注意：这个类不是 Nest 单例——同一个进程里要跑两份不同配置的实例
 * （应答的主模型 + 抽取巩固的便宜模型），所以由 llm.module.ts 里的
 * 工厂按 token 造出来，见 MAIN_LLM / MEMORY_LLM。
 */
export class LLM {
  private client: OpenAI;
  private model: string;
  private createParams: Record<string, any>;

  constructor(config: LLMConfig) {
    this.client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    });
    this.model = config.model ?? "gpt-4o-mini";
    this.createParams = config.createParams ?? {};
  }

  /**
   * 一次性返回完整回复
   */
  async chat(
    messages: ChatCompletionMessageParam[],
    options?: ChatOptions
  ): Promise<LLMResult> {
    const completion = await this.client.chat.completions.create(
      {
        ...this.createParams,
        model: this.model,
        messages,
        stream: false,
        ...(options?.tools?.length ? { tools: options.tools } : {}),
      },
      { signal: options?.signal }
    );
    const message = completion.choices[0]?.message;
    return {
      content: message?.content ?? "",
      toolCalls: (message?.tool_calls ?? []).flatMap((e) =>
        e.type === "function"
          ? [{ id: e.id, name: e.function.name, arguments: e.function.arguments }]
          : []
      ),
    };
  }

  /**
   * 流式返回，每收到一段文本就回调一次
   *
   * 注意：工具调用的增量不会走 onDelta——它不是给用户听的，
   * 聚合完整后由调用方决定怎么处理
   */
  async chatStream(
    messages: ChatCompletionMessageParam[],
    options: ChatOptions & { onDelta: (text: string) => void }
  ): Promise<LLMResult> {
    const completion = await this.client.chat.completions.create(
      {
        ...this.createParams,
        model: this.model,
        messages,
        stream: true,
        ...(options.tools?.length ? { tools: options.tools } : {}),
      },
      { signal: options.signal }
    );

    let content = "";
    // 工具调用是按 index 分片流下来的：id 和 name 通常只在第一片里出现，
    // arguments 则是一个字符一个字符拼出来的
    const calls = new Map<number, ToolCall>();
    for await (const chunk of completion) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        content += delta.content;
        options.onDelta(delta.content);
      }
      for (const part of delta?.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
        if (part.id) {
          call.id = part.id;
        }
        if (part.function?.name) {
          call.name += part.function.name;
        }
        if (part.function?.arguments) {
          call.arguments += part.function.arguments;
        }
        calls.set(part.index, call);
      }
    }

    return {
      content,
      toolCalls: [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, e]) => e)
        .filter((e) => e.name),
    };
  }
}

/**
 * 把工具调用还原成发回给模型的 assistant 消息
 */
export function toolCallMessage(result: LLMResult): ChatCompletionMessageParam {
  return {
    role: "assistant",
    content: result.content || null,
    tool_calls: result.toolCalls.map((e) => ({
      id: e.id,
      type: "function",
      function: { name: e.name, arguments: e.arguments },
    })),
  };
}
