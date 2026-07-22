import { Module } from "@nestjs/common";
import { MemoryModule } from "../memory/memory.module";
import { TodoModule } from "../todo/todo.module";
import { ToolRegistry } from "./tool.registry";

/**
 * 工具库模块：把各业务域的工具收拢到 ToolRegistry 统一管理
 *
 * 新增工具只需：让对应 service 实现 ToolProvider，在 ToolRegistry 里注册。
 */
@Module({
  imports: [MemoryModule, TodoModule],
  providers: [ToolRegistry],
  exports: [ToolRegistry],
})
export class ToolModule {}
