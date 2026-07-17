import { Module } from "@nestjs/common";
import { kAssistantConfig } from "../config";
import { MemoryModule } from "../memory/memory.module";
import { SoulModule } from "../soul/soul.module";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";
import { CHAT_CONFIG, SESSION_CONFIG } from "./chat.types";
import { SessionService } from "./session.service";

@Module({
  imports: [MemoryModule, SoulModule],
  controllers: [ChatController],
  providers: [
    { provide: CHAT_CONFIG, useValue: kAssistantConfig.chat },
    { provide: SESSION_CONFIG, useValue: kAssistantConfig.session },
    ChatService,
    SessionService,
  ],
  exports: [SessionService],
})
export class ChatModule {}
