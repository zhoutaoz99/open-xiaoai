import { Module } from "@nestjs/common";
import { kAssistantConfig } from "../config";
import { SoulController } from "./soul.controller";
import { SoulService } from "./soul.service";
import { SOUL_CONFIG } from "./soul.types";

@Module({
  controllers: [SoulController],
  providers: [
    { provide: SOUL_CONFIG, useValue: kAssistantConfig.soul },
    SoulService,
  ],
  exports: [SoulService],
})
export class SoulModule {}
