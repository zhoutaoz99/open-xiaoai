import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../api-key.guard";
import { TranscriptService } from "./transcript.service";

/**
 * 对话记录接口，给前台看历史用
 *
 * 注意：/chat 不在这里，它在 chat 域——那条路是给音箱走的，
 * 协议一个字都不能变；这里是给人看的。
 */
@Controller()
@UseGuards(ApiKeyGuard)
export class TranscriptController {
  constructor(private transcript: TranscriptService) {}

  /**
   * 会话列表
   */
  @Get("sessions")
  async sessions() {
    return { sessions: await this.transcript.sessions() };
  }

  /**
   * 一段段对话，最近的在前
   *
   * 注意：这不是 /sessions。session_id 由 migpt 那边固定给（默认只有一个
   * default），拿它分不开「一次对话」——段是落库时分好的，见 Conversation。
   */
  @Get("conversations")
  async conversations(@Query("limit") limit?: string) {
    // 不做游标翻页：段数最多也就是轮次数，而轮次已经被 MEMORY_TRANSCRIPT_DAYS
    // 封了顶；个人部署里几百段一次给完，比让侧栏也去翻页简单得多
    const size = clamp(Number(limit) || 200, 1, 500);
    return { conversations: await this.transcript.conversations(size) };
  }

  /**
   * 翻页列出对话轮次
   *
   * @param before 游标：只取这个 id 之前的
   * @param conversationId 只取这段对话的轮次（配合 /conversations）
   */
  @Get("turns")
  async turns(
    @Query("sessionId") sessionId?: string,
    @Query("before") before?: string,
    @Query("limit") limit?: string,
    @Query("conversationId") conversationId?: string
  ) {
    const size = clamp(Number(limit) || 30, 1, 200);
    // 多取一条来判断还有没有下一页，比再跑一次 count(*) 便宜
    const rows = await this.transcript.list({
      sessionId: sessionId || undefined,
      before: before || undefined,
      conversationId: conversationId || undefined,
      limit: size + 1,
    });
    const turns = rows.slice(0, size);
    return {
      turns,
      hasMore: rows.length > size,
      nextCursor: rows.length > size ? turns[turns.length - 1]?.id : null,
    };
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}
