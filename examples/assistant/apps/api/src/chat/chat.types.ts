export interface ChatConfig {
  /**
   * API 密钥，需要和 migpt 的 AGENT_API_KEY 一致
   *
   * 注意：未配置时不校验
   */
  apiKey?: string;
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
   * 命中这些关键词时退出连续对话（唤醒状态）
   *
   * 注意：只在 migpt 开了 KEEP_AWAKE 时才有可见效果——通过响应里的
   * keep_awake:false 告诉 migpt 本轮播完别再开收音窗口，见 PROTOCOL.md。
   */
  exitKeywords: string[];
  /**
   * 退出连续对话时的告别话术
   */
  exitText: string;
}

export interface SessionConfig {
  /**
   * 每个会话最多记住多少轮对话
   *
   * 注意：单位是「轮」，一轮 = 一问一答。
   * 这是安全阀不是目标——真正决定对话有多长的是 ttl。
   */
  maxTurns: number;
  /**
   * 会话闲置多久后清空（毫秒）
   *
   * 注意：这就是"一轮对话结束"的判定——协议里没有唤醒边界，
   * 说完话隔了这么久没下文，就算这轮聊完了
   */
  ttl: number;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
}

/**
 * /chat 的请求体
 *
 * 注意：这个协议是和 migpt 约定死的，见 examples/migpt/PROTOCOL.md。
 * 前台再怎么加功能，这里一个字都不能变。
 */
export interface ChatRequest {
  request_id?: string;
  session_id?: string;
  text?: string;
  stream?: boolean;
  timestamp?: number;
}

export const CHAT_CONFIG = Symbol("CHAT_CONFIG");
export const SESSION_CONFIG = Symbol("SESSION_CONFIG");
