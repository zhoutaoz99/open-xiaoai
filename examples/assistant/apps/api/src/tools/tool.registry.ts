import { Injectable } from "@nestjs/common";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolCall } from "../llm/llm.types";
import { MemoryService } from "../memory/memory.service";
import { TodoService } from "../todo/todo.service";
import type { ToolProvider } from "./tool.types";

type ToolFn = (args: Record<string, unknown>) => string | Promise<string>;

/**
 * 工具库：聚合所有 ToolProvider，统一声明、分发、生成提示词
 *
 * 约定：provider 上与 schema.function.name 同名的方法即为执行体，
 * Registry 按名字直接调用，无需额外 handler 映射。
 */
@Injectable()
export class ToolRegistry {
  private schemas: ChatCompletionTool[] = [];
  private fns = new Map<string, ToolFn>();
  private providers: ToolProvider[];

  constructor(memory: MemoryService, todo: TodoService) {
    this.providers = [memory, todo];
    for (const p of this.providers) {
      for (const schema of p.tools()) {
        this.schemas.push(schema);
        const fn = (p as unknown as Record<string, unknown>)[schema.function.name];
        if (typeof fn === "function") {
          this.fns.set(schema.function.name, fn.bind(p) as ToolFn);
        }
      }
    }
  }

  allTools(): ChatCompletionTool[] {
    return this.schemas;
  }

  promptSection(): string {
    return this.providers
      .map((p) => p.promptHints())
      .filter(Boolean)
      .join("\n");
  }

  async dispatch(call: ToolCall): Promise<string> {
    const fn = this.fns.get(call.name);
    if (!fn) {
      return `没有名为 ${call.name} 的工具。`;
    }
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch (_) {
      // 参数是模型生成的，可能不是合法 JSON
    }
    return fn(args);
  }
}
