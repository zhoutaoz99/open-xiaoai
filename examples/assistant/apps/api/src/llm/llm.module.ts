import { Global, Module } from "@nestjs/common";
import { kAssistantConfig } from "../config";
import { LLM } from "./llm.service";
import { MAIN_LLM, MEMORY_LLM } from "./llm.types";

/**
 * 大模型客户端
 *
 * 注意：两份实例，配置不同——主模型负责应答（用户在等），
 * 记忆模型负责抽取和巩固（后台跑，可以配个便宜的）。
 */
@Global()
@Module({
  providers: [
    { provide: MAIN_LLM, useFactory: () => new LLM(kAssistantConfig.openai) },
    { provide: MEMORY_LLM, useFactory: () => new LLM(kAssistantConfig.memory.openai) },
  ],
  exports: [MAIN_LLM, MEMORY_LLM],
})
export class LLMModule {}
