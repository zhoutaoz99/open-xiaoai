import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiKeyGuard } from "../api-key.guard";
import { TodoService } from "./todo.service";
import type { TodoPatch, TodoStatus } from "./todo.types";

interface CreateBody {
  content?: unknown;
  dueAt?: unknown;
  remind?: unknown;
}

interface PatchBody {
  content?: unknown;
  dueAt?: unknown;
  remind?: unknown;
  status?: unknown;
}

const kStatuses: TodoStatus[] = ["pending", "done", "cancelled"];

/**
 * 待办的读写，给前台的待办页用
 *
 * 注意：复用 ASSISTANT_API_KEY 鉴权，不碰 /chat——那是音箱走的路，
 * 从浏览器发起会污染会话上下文和记忆（见 app/api/[...path]/route.ts 的白名单）。
 */
@Controller("todos")
@UseGuards(ApiKeyGuard)
export class TodoController {
  constructor(private todo: TodoService) {}

  @Get()
  async list(@Query("status") status?: string) {
    const filter = kStatuses.find((s) => s === status);
    const todos = await this.todo.list(filter ? { status: filter } : undefined);
    return { todos };
  }

  @Post()
  async create(@Body() body: CreateBody) {
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) {
      throw new BadRequestException("content 不能为空");
    }
    const dueAt = typeof body.dueAt === "string" && body.dueAt.trim() ? body.dueAt.trim() : null;
    const remind = typeof body.remind === "boolean" ? body.remind : true;
    return this.todo.addTodo({ content, dueAt, remind, source: "web" });
  }

  @Patch(":id")
  async patch(@Param("id") id: string, @Body() body: PatchBody) {
    const patch: TodoPatch = {};
    if (typeof body.content === "string") patch.content = body.content.trim();
    if (typeof body.dueAt === "string") patch.dueAt = body.dueAt.trim() || null;
    else if (body.dueAt === null) patch.dueAt = null;
    if (typeof body.remind === "boolean") patch.remind = body.remind;
    if (typeof body.status === "string") {
      const status = kStatuses.find((s) => s === body.status);
      if (!status) {
        throw new BadRequestException(`status 只能是 ${kStatuses.join(" / ")}`);
      }
      patch.status = status;
    }
    const todo = await this.todo.updateTodo(id, patch);
    if (!todo) {
      throw new NotFoundException(`没找到待办 ${id}`);
    }
    return todo;
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    const ok = await this.todo.removeTodo(id);
    if (!ok) {
      throw new NotFoundException(`没找到待办 ${id}`);
    }
    return { ok: true, id };
  }
}
