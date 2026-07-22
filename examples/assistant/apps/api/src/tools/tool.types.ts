import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 工具提供者：每个业务域实现这个接口，把自己的工具注册进工具库
 *
 * 约定：provider 上必须存在与 schema.function.name 同名的方法，
 * 签名为 (args: Record<string, unknown>) => string | Promise<string>。
 * Registry 按名字直接调用，无需额外映射。
 */
export interface ToolProvider {
  tools(): ChatCompletionTool[];
  promptHints(): string;
}
