import { Global, Module } from "@nestjs/common";
import { kAssistantConfig } from "../config";
import { DATABASE_CONFIG } from "./data.types";
import { PostgresService } from "./postgres.service";

/**
 * 数据层：全局导出，各业务域无需重复 import 即可注入 PG
 *
 * 注意：骨架模板里这一层还有 redis-cache.service，这个项目没有——
 * 会话窗口是纯内存的（见 chat/session.service.ts 里的说明），
 * 单进程单实例也没有跨进程缓存的需求，加一个谁都不读的 Redis 只是负担。
 */
@Global()
@Module({
  providers: [
    { provide: DATABASE_CONFIG, useValue: kAssistantConfig.database },
    PostgresService,
  ],
  exports: [PostgresService],
})
export class DataModule {}
