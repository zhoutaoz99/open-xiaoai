import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { ChatModule } from "./chat/chat.module";
import { DataModule } from "./data/data.module";
import { LLMModule } from "./llm/llm.module";
import { MemoryModule } from "./memory/memory.module";
import { SoulModule } from "./soul/soul.module";
import { TranscriptModule } from "./transcript/transcript.module";

/**
 * 业务域一览：
 * - chat       音箱走的 /chat，会话窗口、检索循环
 * - memory     记忆库、抽取、巩固、提炼记录
 * - transcript 对话轮次
 * - soul       灵魂与画像（两份 Markdown 文件）
 *
 * data 和 llm 是 @Global 的基础设施，各域直接注入，不用重复 import。
 */
@Module({
  imports: [DataModule, LLMModule, SoulModule, TranscriptModule, MemoryModule, ChatModule],
  controllers: [AppController],
})
export class AppModule {}
