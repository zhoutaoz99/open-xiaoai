import type { NewTodo, Todo, TodoFilter, TodoPatch } from "./todo.types";

/**
 * 待办存储的 DI token
 *
 * 注意：这就是"数据层可插拔"的那道缝。TodoService、reminder.scheduler、
 * todo.controller 全都只依赖这个接口，不认识具体实现。默认绑到 PgTodoStore
 * （本地 Postgres）；想接 Todoist / CalDAV / 家庭共享清单，写个实现同接口的
 * ExternalTodoStore，在 todo.module.ts 里换掉 useClass 即可，业务代码一行不改。
 */
export const TODO_STORE = Symbol("TODO_STORE");

/**
 * 待办存储：增删改查 + 调度器要用的到期扫描与触发标记
 */
export interface TodoStore {
  add(input: NewTodo): Promise<Todo>;
  list(filter?: TodoFilter): Promise<Todo[]>;
  get(id: string): Promise<Todo | null>;
  update(id: string, patch: TodoPatch): Promise<Todo | null>;
  complete(id: string): Promise<Todo | null>;
  cancel(id: string): Promise<Todo | null>;
  /**
   * 硬删（前台的删除按钮）
   */
  remove(id: string): Promise<boolean>;

  // ---- 调度器专用 ----

  /**
   * 到点该处理的待办：pending、remind、到点、还没 fire、没在贪睡
   *
   * 注意：迟到多久算过期由调度器判断（它才知道 maxLate 配置）——这里只管
   * "到点了没"。过期的那些调度器会 markFired 标记跳过，下一轮就不再返回了。
   */
  dueForReminder(now: Date): Promise<Todo[]>;
  /**
   * 标记已触发（幂等的关键）
   *
   * 注意：用 WHERE fired_at IS NULL 让"抢先标记"在 SQL 层原子化——
   * 两轮扫描万一交叠，同一条也只会被标记成功一次
   */
  markFired(id: string, at: Date): Promise<boolean>;
  snooze(id: string, until: Date): Promise<Todo | null>;
}
