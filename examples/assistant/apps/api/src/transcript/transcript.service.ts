import { Inject, Injectable } from "@nestjs/common";
import { TranscriptRepository } from "./transcript.repository";
import {
  TRANSCRIPT_CONFIG,
  type Conversation,
  type ListTurnsQuery,
  type SessionSummary,
  type TranscriptConfig,
  type Turn,
} from "./transcript.types";

/**
 * 对话流水：每轮问答落一条
 *
 * 它有两个读者，需求正好相反：
 * - 定时巩固要"最近一批，按先后顺序"，用来挖模式——单次"问天气"太琐碎，
 *   抽取器按防污染原则不记，"每天早上都问天气"这个模式只有流水里挖得出来。
 * - 前台要"按会话翻页，最近的在前"。
 */
@Injectable()
export class TranscriptService {
  constructor(
    @Inject(TRANSCRIPT_CONFIG) private config: TranscriptConfig,
    private repo: TranscriptRepository
  ) {}

  get enabled() {
    return this.config.days > 0;
  }

  /**
   * @param conversationId 属于哪一段对话，由 SessionService 在建会话窗口时生成
   * @returns 落盘后的轮次；没开流水时返回 undefined
   */
  async append(
    conversationId: string,
    sessionId: string,
    user: string,
    assistant: string
  ): Promise<Turn | undefined> {
    if (!this.enabled) {
      return undefined;
    }
    return this.repo.insert(conversationId, sessionId, user, assistant);
  }

  /**
   * 巩固任务的原料：保留期内最近的若干轮
   *
   * @param limit 上限。14 天的流水可能上千条，全塞给模型既超预算又稀释注意力，
   *              挖模式看的是近期的重复，取最近的够用。
   */
  async recent(limit: number): Promise<Turn[]> {
    if (!this.enabled) {
      return [];
    }
    return this.repo.recent(this.config.days, limit);
  }

  list(query: ListTurnsQuery): Promise<Turn[]> {
    return this.repo.list(query);
  }

  sessions(): Promise<SessionSummary[]> {
    return this.repo.sessions();
  }

  /**
   * 列出一段段对话，给前台的对话列表用
   */
  async conversations(limit: number): Promise<Conversation[]> {
    if (!this.enabled) {
      return [];
    }
    return this.repo.conversations(limit);
  }

  clear(): Promise<void> {
    return this.repo.clear();
  }

  /**
   * 清理过期流水，防止表无限增长
   *
   * 注意：配成 0（不落流水）时把已有的也一并删掉——用户关掉它就是不想让
   * 对话原文留在机器上，留着旧数据等于没关
   */
  async prune(): Promise<void> {
    if (!this.enabled) {
      await this.repo.clear();
      return;
    }
    const removed = await this.repo.prune(this.config.days);
    if (removed.conversations) {
      console.log(
        `🧹 已清理 ${removed.conversations} 段过期对话、共 ${removed.turns} 轮（保留 ${this.config.days} 天）`
      );
    }
  }
}
