import type { ChatCompletionTool } from "openai/resources/chat/completions";

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

/**
 * 模型发起的一次工具调用
 */
export interface ToolCall {
  id: string;
  name: string;
  /**
   * JSON 字符串，是模型生成的，不保证合法
   */
  arguments: string;
}

export interface LLMResult {
  content: string;
  toolCalls: ToolCall[];
}

export interface ChatOptions {
  signal?: AbortSignal;
  /**
   * 本次请求声明的工具，不传则模型无法调用工具
   */
  tools?: ChatCompletionTool[];
}

/**
 * 应答用的主模型
 */
export const MAIN_LLM = Symbol("MAIN_LLM");

/**
 * 抽取/巩固用的模型，可以配个便宜的
 */
export const MEMORY_LLM = Symbol("MEMORY_LLM");
