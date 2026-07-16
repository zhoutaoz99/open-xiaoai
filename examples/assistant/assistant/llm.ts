import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export interface LLMConfig {
  /**
   * 你的大模型服务提供商的接口地址
   *
   * 支持兼容 OpenAI 接口的大模型服务，比如：DeepSeek V3 等
   *
   * 注意：一般以 /v1 结尾，不包含 /chat/completions 部分
   */
  baseURL?: string;
  /**
   * API 密钥
   */
  apiKey?: string;
  /**
   * 模型名称
   */
  model?: string;
  /**
   * 思考模式、温度等额外的请求参数
   */
  createParams?: Record<string, any>;
}

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
    options?: { signal?: AbortSignal }
  ): Promise<string> {
    const completion = await this.client.chat.completions.create(
      { ...this.createParams, model: this.model, messages, stream: false },
      { signal: options?.signal }
    );
    return completion.choices[0]?.message?.content ?? "";
  }

  /**
   * 流式返回，每收到一段就回调一次，最终返回完整回复
   */
  async chatStream(
    messages: ChatCompletionMessageParam[],
    options: { signal?: AbortSignal; onDelta: (text: string) => void }
  ): Promise<string> {
    const completion = await this.client.chat.completions.create(
      { ...this.createParams, model: this.model, messages, stream: true },
      { signal: options.signal }
    );
    let answer = "";
    for await (const chunk of completion) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) {
        answer += text;
        options.onDelta(text);
      }
    }
    return answer;
  }
}
