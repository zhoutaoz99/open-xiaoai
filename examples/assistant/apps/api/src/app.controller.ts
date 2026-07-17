import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "./api-key.guard";
import { MemoryService } from "./memory/memory.service";
import { SessionService } from "./chat/session.service";
import { TranscriptService } from "./transcript/transcript.service";

@Controller()
export class AppController {
  constructor(
    private memory: MemoryService,
    private sessions: SessionService,
    private transcript: TranscriptService
  ) {}

  /**
   * 健康检查
   *
   * 注意：不鉴权。migpt 启动时会探一次，探不到只告警不阻塞。
   */
  @Get("health")
  health() {
    return {
      status: "ok",
      memory: {
        enabled: this.memory.enabled,
        size: this.memory.size,
      },
      sessions: this.sessions.size,
      transcript: this.transcript.enabled,
    };
  }

  /**
   * 实时状态，给前台 1 秒轮询用：这会儿在对话、在闲置倒计时、还是在巩固画像
   *
   * 注意：和 /health 分开。health 不鉴权、给 migpt 探活、形状要稳；
   * 这个是给前台看的应用内部状态，鉴权，随需要加字段。
   */
  @Get("status")
  @UseGuards(ApiKeyGuard)
  status() {
    const s = this.sessions.status();
    return {
      conversation: {
        // 还有活着的会话 = 有人正在这段对话里（应答中，或答完还没闲置过期）
        active: s.active > 0,
        // 模型正在应答这一句
        busy: s.busy,
        // 最近一个会话还有多少秒没新发言就巩固画像；应答中时为 null（没在倒计时）
        idleInSeconds: s.idleInMs === null ? null : Math.max(0, Math.round(s.idleInMs / 1000)),
      },
      memory: {
        enabled: this.memory.enabled,
        consolidating: this.memory.isConsolidating,
        pendingChanges: this.memory.pendingChanges,
        lastConsolidatedAt: this.memory.lastConsolidatedAt,
      },
    };
  }
}
