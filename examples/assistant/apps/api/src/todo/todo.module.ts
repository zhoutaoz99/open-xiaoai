import { Module } from "@nestjs/common";
import { kAssistantConfig } from "../config";
import { SoulModule } from "../soul/soul.module";
import { createNotifier, NOTIFIER } from "./notifier";
import { PgTodoStore } from "./todo.repository";
import { ReminderScheduler } from "./reminder.scheduler";
import { TodoController } from "./todo.controller";
import { TodoService } from "./todo.service";
import { TODO_STORE } from "./todo.store";
import { TODO_CONFIG } from "./todo.types";

/**
 * 待办与主动提醒
 *
 * 依赖 soul（提醒措辞要用助手的口吻）；PG 和 MEMORY_LLM 是 @Global 基础设施，
 * 直接注入。不依赖 memory——待办和记忆是两回事（见 docs/todo.md 三）。
 *
 * TODO_STORE 是数据层可插拔的缝：默认 PgTodoStore（本地 Postgres），
 * 想接外部待办系统就在这里把 useClass 换成自己的实现，业务代码一行不改。
 */
@Module({
  imports: [SoulModule],
  controllers: [TodoController],
  providers: [
    { provide: TODO_CONFIG, useValue: kAssistantConfig.todo },
    { provide: TODO_STORE, useClass: PgTodoStore },
    { provide: NOTIFIER, useFactory: () => createNotifier(kAssistantConfig.todo) },
    TodoService,
    ReminderScheduler,
  ],
  exports: [TodoService],
})
export class TodoModule {}
