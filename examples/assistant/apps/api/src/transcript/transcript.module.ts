import { Module } from "@nestjs/common";
import { kAssistantConfig } from "../config";
import { TranscriptController } from "./transcript.controller";
import { TranscriptRepository } from "./transcript.repository";
import { TranscriptService } from "./transcript.service";
import { TRANSCRIPT_CONFIG } from "./transcript.types";

@Module({
  controllers: [TranscriptController],
  providers: [
    { provide: TRANSCRIPT_CONFIG, useValue: { days: kAssistantConfig.memory.transcriptDays } },
    TranscriptService,
    TranscriptRepository,
  ],
  exports: [TranscriptService],
})
export class TranscriptModule {}
