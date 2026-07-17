import { Injectable } from "@nestjs/common";
import { PostgresService } from "../data/postgres.service";
// nowISO 是个纯日期工具，跨域共用（transcript/memory 都用它）——
// import 一个函数不构成模块依赖，TodoModule 并不 import MemoryModule
import { nowISO } from "../memory/memory.types";
import type { TodoStore } from "./todo.store";
import { newTodoId, type NewTodo, type Todo, type TodoFilter, type TodoPatch } from "./todo.types";

interface TodoRow {
  id: string;
  content: string;
  due_at: Date | null;
  remind: boolean;
  status: string;
  fired_at: Date | null;
  snoozed_until: Date | null;
  source: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * 待办的默认本地实现：Postgres
 *
 * 注意：这只是 TodoStore 的默认落点。整套业务只认接口，换外部存储时
 * 写一个同样 implements TodoStore 的类、在 todo.module.ts 里换 useClass 即可。
 */
@Injectable()
export class PgTodoStore implements TodoStore {
  constructor(private pg: PostgresService) {}

  async add(input: NewTodo): Promise<Todo> {
    const rows = await this.pg.query<TodoRow>(
      `INSERT INTO todos (id, content, due_at, remind, source)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [newTodoId(), input.content, input.dueAt ?? null, input.remind ?? true, input.source ?? "voice"]
    );
    return toTodo(rows[0]!);
  }

  async list(filter?: TodoFilter): Promise<Todo[]> {
    const params: unknown[] = [];
    let where = "";
    if (filter?.status) {
      params.push(filter.status);
      where = `WHERE status = $1`;
    }
    // pending 的按到期时间正序（越近越靠前，没时间的排最后）；其余按更新时间倒序
    const rows = await this.pg.query<TodoRow>(
      `SELECT * FROM todos ${where}
       ORDER BY status = 'pending' DESC,
                due_at ASC NULLS LAST,
                updated_at DESC`,
      params
    );
    return rows.map(toTodo);
  }

  async get(id: string): Promise<Todo | null> {
    const rows = await this.pg.query<TodoRow>(`SELECT * FROM todos WHERE id = $1`, [id]);
    return rows[0] ? toTodo(rows[0]) : null;
  }

  async update(id: string, patch: TodoPatch): Promise<Todo | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.content !== undefined) set("content", patch.content);
    if (patch.dueAt !== undefined) set("due_at", patch.dueAt);
    if (patch.remind !== undefined) set("remind", patch.remind);
    if (patch.status !== undefined) set("status", patch.status);
    if (!sets.length) {
      return this.get(id);
    }
    params.push(id);
    const rows = await this.pg.query<TodoRow>(
      `UPDATE todos SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
      params
    );
    return rows[0] ? toTodo(rows[0]) : null;
  }

  complete(id: string): Promise<Todo | null> {
    return this.update(id, { status: "done" });
  }

  cancel(id: string): Promise<Todo | null> {
    return this.update(id, { status: "cancelled" });
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this.pg.query(`DELETE FROM todos WHERE id = $1 RETURNING id`, [id]);
    return rows.length > 0;
  }

  async dueForReminder(now: Date): Promise<Todo[]> {
    const rows = await this.pg.query<TodoRow>(
      `SELECT * FROM todos
       WHERE status = 'pending' AND remind = true
         AND due_at IS NOT NULL AND due_at <= $1
         AND fired_at IS NULL
         AND (snoozed_until IS NULL OR snoozed_until <= $1)
       ORDER BY due_at ASC`,
      [now]
    );
    return rows.map(toTodo);
  }

  async markFired(id: string, at: Date): Promise<boolean> {
    // WHERE fired_at IS NULL：让"抢先标记"在 SQL 层原子化，
    // 两轮扫描交叠时同一条也只标记成功一次
    const rows = await this.pg.query(
      `UPDATE todos SET fired_at = $2, updated_at = now()
       WHERE id = $1 AND fired_at IS NULL RETURNING id`,
      [id, at]
    );
    return rows.length > 0;
  }

  async snooze(id: string, until: Date): Promise<Todo | null> {
    // 贪睡时把 fired_at 清空，让它到点能再次被 dueForReminder 捞到
    const rows = await this.pg.query<TodoRow>(
      `UPDATE todos SET snoozed_until = $2, fired_at = NULL, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, until]
    );
    return rows[0] ? toTodo(rows[0]) : null;
  }
}

function toTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    content: row.content,
    dueAt: row.due_at ? nowISO(row.due_at) : null,
    remind: row.remind,
    status: row.status as Todo["status"],
    firedAt: row.fired_at ? nowISO(row.fired_at) : null,
    snoozedUntil: row.snoozed_until ? nowISO(row.snoozed_until) : null,
    source: row.source,
    createdAt: nowISO(row.created_at),
    updatedAt: nowISO(row.updated_at),
  };
}
