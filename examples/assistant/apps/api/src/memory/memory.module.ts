import { Module } from "@nestjs/common";
import { kAssistantConfig } from "../config";
import { SoulModule } from "../soul/soul.module";
import { TranscriptModule } from "../transcript/transcript.module";
import { MemoryController } from "./memory.controller";
import { MemoryRepository } from "./memory.repository";
import { MemoryService } from "./memory.service";
import { MEMORY_CONFIG } from "./memory.types";

/**
 * 长期记忆
 *
 * 依赖 transcript（巩固的原料是流水）和 soul（画像是巩固的产物）。
 * 反过来那两个域不认识记忆——不然就成环了。
 */
@Module({
  imports: [TranscriptModule, SoulModule],
  controllers: [MemoryController],
  providers: [
    { provide: MEMORY_CONFIG, useValue: kAssistantConfig.memory },
    MemoryService,
    MemoryRepository,
  ],
  // MEMORY_CONFIG 也导出：检索循环归 chat 编排（次数上限、填补话术、传输方式
  // 都是它在用），但这些配置的主人是记忆域，不该在两处各造一份
  exports: [MemoryService, MEMORY_CONFIG],
})
export class MemoryModule {}
