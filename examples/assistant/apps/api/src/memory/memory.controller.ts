import {
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiKeyGuard } from "../api-key.guard";
import { SoulService } from "../soul/soul.service";
import { MemoryService } from "./memory.service";
import type { ExtractionKind } from "./memory.types";

/**
 * 记忆库与提炼记录，给前台用
 */
@Controller()
@UseGuards(ApiKeyGuard)
export class MemoryController {
  constructor(
    private memory: MemoryService,
    private soul: SoulService
  ) {}

  @Get("memories")
  memories() {
    return {
      enabled: this.memory.enabled,
      profile: this.soul.profileText(),
      memories: this.memory.list(),
    };
  }

  /**
   * 手动删一条
   */
  @Delete("memories/:id")
  async remove(@Param("id") id: string) {
    if (!this.memory.enabled) {
      throw new ConflictException("memory disabled");
    }
    if (!(await this.memory.remove(id))) {
      throw new NotFoundException(`记忆 ${id} 不存在`);
    }
    return { ok: true, id };
  }

  /**
   * 提炼记录：每轮对话让助手学到了什么
   *
   * @param turnIds 逗号分隔。前台拿到一页轮次后，用它一次把这些轮次的记录捞回来
   */
  @Get("extractions")
  async extractions(
    @Query("turnIds") turnIds?: string,
    @Query("sessionId") sessionId?: string,
    @Query("kind") kind?: string,
    @Query("before") before?: string,
    @Query("limit") limit?: string
  ) {
    const ids = (turnIds ?? "")
      .split(",")
      .map((e) => e.trim())
      // bigint[] 参数喂进非数字会让整条 SQL 报错，这是外部输入，先挡掉
      .filter((e) => /^\d+$/.test(e));
    const size = clamp(Number(limit) || 50, 1, 200);
    const rows = await this.memory.listExtractions({
      turnIds: ids.length ? ids : undefined,
      sessionId: sessionId || undefined,
      kind: kind === "extract" || kind === "consolidate" ? (kind as ExtractionKind) : undefined,
      before: before || undefined,
      limit: size + 1,
    });
    const extractions = rows.slice(0, size);
    return {
      extractions,
      hasMore: rows.length > size,
      nextCursor: rows.length > size ? extractions[extractions.length - 1]?.id : null,
    };
  }

  /**
   * 手动触发一次巩固
   *
   * 注意：平时它是"对话结束时 + 每天凌晨"跑的，排查和验收时等不起
   */
  @Post("memories/consolidate")
  async consolidate() {
    if (!this.memory.enabled) {
      throw new ConflictException("memory disabled");
    }
    const ok = await this.memory.consolidateNow();
    return {
      ok,
      profile: this.soul.profileText(),
      memories: this.memory.list(),
    };
  }

  /**
   * 清除所有数据：对话、记忆、提炼记录、画像全清，灵魂不动
   *
   * 注意：和语音「清空所有记忆」走的是同一个 wipe()——清除前自动拍快照
   * 存进 memory_snapshots（画像另存一份 .bak），是可恢复的。
   *
   * 注意：这是不可逆操作，前台点之前要二次确认。放 POST 不放 DELETE，
   * 是因为它清的远不止 memories 这一种资源。
   */
  @Post("memories/wipe")
  async wipe() {
    if (!this.memory.enabled) {
      // 记忆关着时对话流水根本不落库，没有「所有数据」可清
      throw new ConflictException("memory disabled");
    }
    await this.memory.wipe();
    return { ok: true };
  }

  /**
   * 快照列表：清空和巩固前拍的那些，后悔药
   */
  @Get("memories/snapshots")
  async snapshots(@Query("limit") limit?: string) {
    return { snapshots: await this.memory.listSnapshots(clamp(Number(limit) || 20, 1, 100)) };
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}
