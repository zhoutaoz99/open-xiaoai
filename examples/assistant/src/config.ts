import type { AssistantConfig } from "./server.js";
import { envList, envNumber, envString, getOpenAICreateParams } from "./env.js";

/**
 * 默认系统提示词
 *
 * 注意：回复会被 migpt 按标点分句后逐句合成语音，所以这里明确要求带标点。
 * 一段没有标点的长回复在流结束前一个字都播不出来，流式就白做了。
 */
const kDefaultSystemPrompt = `你是一个智能助手，请根据用户的问题给出回答。
你的回答会通过音箱用语音播报出来，所以请遵守以下要求：
1. 用简洁、口语化的短句回答，控制在三句话以内；
2. 不要使用 Markdown、列表、代码块或表情符号；
3. 必须使用正常的中文标点断句。`;

export const kAssistantConfig: AssistantConfig = {
  /**
   * 服务监听的端口（在 .env 文件里配置）
   */
  port: envNumber("ASSISTANT_PORT") ?? 8000,
  /**
   * 服务监听的地址（在 .env 文件里配置）
   *
   * 注意：在 Docker 里运行时必须是 0.0.0.0，否则容器外访问不到
   */
  host: envString("ASSISTANT_HOST") ?? "0.0.0.0",
  /**
   * API 密钥（在 .env 文件里配置）
   *
   * 注意：要和 migpt 的 AGENT_API_KEY 保持一致，未配置时不校验
   */
  apiKey: envString("ASSISTANT_API_KEY"),
  /**
   * 系统提示词（在 .env 文件里配置）
   */
  systemPrompt: envString("ASSISTANT_SYSTEM_PROMPT") ?? kDefaultSystemPrompt,
  /**
   * 调用大模型失败时的兜底话术（在 .env 文件里配置）
   */
  errorText: envString("ASSISTANT_ERROR_TEXT") ?? "我这边出了点问题，请稍后再试。",
  /**
   * 命中这些关键词时清空上下文（在 .env 文件里配置）
   */
  resetKeywords: envList("ASSISTANT_RESET_KEYWORDS") ?? [
    "重新开始",
    "清空记忆",
    "忘掉刚才",
  ],
  /**
   * 清空上下文后的回复话术（在 .env 文件里配置）
   */
  resetText: envString("ASSISTANT_RESET_TEXT") ?? "好的，我们重新开始吧。",
  openai: {
    /**
     * 你的大模型服务提供商的接口地址（在 .env 文件里配置）
     *
     * 支持兼容 OpenAI 接口的大模型服务，比如：DeepSeek V3 等
     *
     * 注意：一般以 /v1 结尾，不包含 /chat/completions 部分
     * - ✅ https://api.openai.com/v1
     * - ❌ https://api.openai.com/v1/（最后多了一个 /）
     * - ❌ https://api.openai.com/v1/chat/completions（不需要加 /chat/completions）
     */
    baseURL: envString("OPENAI_BASE_URL"),
    /**
     * API 密钥（在 .env 文件里配置）
     */
    apiKey: envString("OPENAI_API_KEY"),
    /**
     * 模型名称（在 .env 文件里配置）
     */
    model: envString("OPENAI_MODEL"),
    /**
     * 思考模式、温度等额外的请求参数（在 .env 文件里配置）
     */
    createParams: getOpenAICreateParams(),
  },
  session: {
    /**
     * 每个会话最多记住多少轮对话（在 .env 文件里配置）
     *
     * 注意：单位是「轮」，一轮 = 一问一答
     */
    maxTurns: envNumber("ASSISTANT_MAX_TURNS") ?? 10,
    /**
     * 会话闲置多久后清空，单位毫秒（在 .env 文件里配置）
     */
    ttl: envNumber("ASSISTANT_SESSION_TTL_MS") ?? 30 * 60 * 1000,
  },
};
