import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolCall } from "../llm/llm.types";
import { nowISO } from "../memory/memory.types";
import { kTodoTools } from "../prompts";
import { TODO_STORE, type TodoStore } from "./todo.store";
import {
  TODO_CONFIG,
  type NewTodo,
  type Todo,
  type TodoConfig,
  type TodoFilter,
  type TodoPatch,
} from "./todo.types";

/**
 * 一天
 */
const kDay = 24 * 60 * 60 * 1000;

/**
 * 临期待办往后看几天（并入 chat 的临期注入，让模型在对话里有 ambient 感知）
 */
const kUpcomingDays = 3;

/**
 * 临期待办最多注入几条
 */
const kUpcomingMax = 3;

/**
 * 待办与提醒的对外门面
 *
 * 注意：整套业务只认 TodoStore 接口，不认识具体是 Postgres 还是外部服务。
 * upcoming() 走内存缓存（同记忆的 upcoming），不在应答路径上跑 SQL。
 */
@Injectable()
export class TodoService implements OnModuleInit {
  /**
   * pending 待办的内存缓存，供 upcoming() 同步、零 IO 地读——应答路径上不查库
   */
  private cache: Todo[] = [];

  constructor(
    @Inject(TODO_CONFIG) private config: TodoConfig,
    @Inject(TODO_STORE) private store: TodoStore
  ) {}

  async onModuleInit() {
    await this.refresh();
  }

  tools(): ChatCompletionTool[] {
    return kTodoTools;
  }

  /**
   * 执行模型发起的工具调用
   *
   * 注意：签名是 async——待办的增删查都要落库。chat 的工具循环 await 它。
   */
  async runTool(call: ToolCall): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch (_) {
      // 参数是模型生成的，可能不是合法 JSON
    }
    switch (call.name) {
      case "add_todo":
        return this.runAdd(args);
      case "list_todos":
        return this.runList(args);
      case "complete_todo":
        return this.runComplete(args);
      default:
        return `没有名为 ${call.name} 的工具。`;
    }
  }

  private async runAdd(args: Record<string, unknown>): Promise<string> {
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (!content) {
      return "没能记下待办：内容为空。";
    }
    const remind = typeof args.remind === "boolean" ? args.remind : true;
    const dueAt = this.normalizeDueAt(typeof args.dueAt === "string" ? args.dueAt : null);
    const todo = await this.addTodo({ content, dueAt, remind, source: "voice" });
    if (todo.dueAt && todo.remind) {
      return `已记下待办（${todo.id}）：${todo.content}，将在 ${formatDue(todo.dueAt)} 主动提醒。`;
    }
    if (todo.dueAt) {
      return `已记下待办（${todo.id}）：${todo.content}，时间 ${formatDue(todo.dueAt)}（不主动提醒）。`;
    }
    return `已记下待办（${todo.id}）：${todo.content}。`;
  }

  private async runList(args: Record<string, unknown>): Promise<string> {
    const status = (["pending", "done", "cancelled"] as const).find((s) => s === args.status);
    const todos = await this.store.list({ status: status ?? "pending" });
    if (!todos.length) {
      return status && status !== "pending" ? `没有${status}的待办。` : "当前没有待办。";
    }
    return todos
      .map((t) => `${t.id}｜${t.content}${t.dueAt ? `（${formatDue(t.dueAt)}${t.remind ? "，会提醒" : ""}）` : ""}`)
      .join("\n");
  }

  private async runComplete(args: Record<string, unknown>): Promise<string> {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) {
      return "没能完成待办：缺少 id。";
    }
    const todo = await this.completeTodo(id);
    return todo ? `已把「${todo.content}」标记为完成。` : `没找到 id 为 ${id} 的待办。`;
  }

  // ---- 业务方法（工具与 controller 共用，都走这里以便刷新缓存）----

  list(filter?: TodoFilter): Promise<Todo[]> {
    return this.store.list(filter);
  }

  async addTodo(input: NewTodo): Promise<Todo> {
    const todo = await this.store.add({ ...input, dueAt: this.normalizeDueAt(input.dueAt) });
    await this.refresh();
    console.log(`📝 新增待办 ${todo.id}：${todo.content}${todo.dueAt ? ` @ ${formatDue(todo.dueAt)}` : ""}`);
    return todo;
  }

  async updateTodo(id: string, patch: TodoPatch): Promise<Todo | null> {
    const next: TodoPatch = { ...patch };
    if (patch.dueAt !== undefined) {
      next.dueAt = this.normalizeDueAt(patch.dueAt);
    }
    const todo = await this.store.update(id, next);
    await this.refresh();
    return todo;
  }

  async completeTodo(id: string): Promise<Todo | null> {
    const todo = await this.store.complete(id);
    await this.refresh();
    return todo;
  }

  async cancelTodo(id: string): Promise<Todo | null> {
    const todo = await this.store.cancel(id);
    await this.refresh();
    return todo;
  }

  async removeTodo(id: string): Promise<boolean> {
    const ok = await this.store.remove(id);
    await this.refresh();
    return ok;
  }

  // ---- 调度器用（收口到 service，让 store 只被一处碰）----

  dueReminders(now: Date): Promise<Todo[]> {
    return this.store.dueForReminder(now);
  }

  markFired(id: string, at: Date): Promise<boolean> {
    return this.store.markFired(id, at);
  }

  /**
   * 重新载入 pending 缓存
   */
  async refresh(): Promise<void> {
    try {
      this.cache = await this.store.list({ status: "pending" });
    } catch (e) {
      console.error("❌ 刷新待办缓存失败", e);
    }
  }

  /**
   * 未来几天内的待办（并入 chat 的临期注入）
   *
   * 注意：同记忆的 upcoming()——读内存缓存、同步、零 IO，不在应答路径上跑 SQL。
   * 含已过期但还没完成的（"你还有件事没做"也值得提一嘴）。
   */
  upcoming(): Todo[] {
    const until = Date.now() + kUpcomingDays * kDay;
    return this.cache
      .filter((t) => t.dueAt && new Date(t.dueAt).getTime() <= until)
      .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))
      .slice(0, kUpcomingMax);
  }

  /**
   * 把模型给的时间规整成带本地偏移的 ISO 时刻
   *
   * 注意：只给了日期没给时刻的（"明天提醒我买菜"），补上默认提醒时刻。
   */
  private normalizeDueAt(raw?: string | null): string | null {
    if (!raw) {
      return null;
    }
    const s = raw.trim();
    if (!s) {
      return null;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = new Date(`${s}T${this.config.defaultTime}:00`);
      return Number.isNaN(d.getTime()) ? null : nowISO(d);
    }
    const d = new Date(s);
    // 解析不了就原样存，交给库；至少不会因为一次格式意外把待办丢了
    return Number.isNaN(d.getTime()) ? s : nowISO(d);
  }
}

/**
 * 2026-07-18T15:00:00+08:00 → 07-18 15:00
 */
function formatDue(iso: string): string {
  return iso.slice(5, 16).replace("T", " ");
}
