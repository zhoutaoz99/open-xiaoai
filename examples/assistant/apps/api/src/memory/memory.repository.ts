import { Injectable } from "@nestjs/common";
import { PostgresService } from "../data/postgres.service";
import {
  nowISO,
  type ExtractionRecord,
  type ListExtractionsQuery,
  type MemoryChanges,
  type MemoryItem,
  type MemoryMeta,
  type MemoryStat,
} from "./memory.types";

interface MemoryRow {
  id: string;
  content: string;
  type: string;
  subjects: string[];
  keywords: string[];
  importance: number;
  due_at: string | null;
  created_at: Date;
  updated_at: Date;
  hits: number;
  last_used_at: Date | null;
  payload: { evidence?: string };
}

interface ExtractionRow {
  id: string;
  kind: string;
  status: string;
  session_id: string | null;
  turn_ids: string[];
  created_at: Date;
  payload: {
    applied?: ExtractionRecord["applied"];
    stat?: MemoryStat;
    profileBefore?: string;
    profileAfter?: string;
    error?: string;
    reason?: string;
  };
}

/**
 * 要写进提炼记录的一条
 */
export interface NewExtraction {
  kind: ExtractionRecord["kind"];
  status: ExtractionRecord["status"];
  sessionId?: string | null;
  turnIds?: string[];
  applied?: ExtractionRecord["applied"];
  stat?: MemoryStat;
  profileBefore?: string;
  profileAfter?: string;
  error?: string;
  reason?: string;
}

@Injectable()
export class MemoryRepository {
  constructor(private pg: PostgresService) {}

  // ---- 记忆库 ----

  async all(): Promise<MemoryItem[]> {
    const rows = await this.pg.query<MemoryRow>(`SELECT * FROM memories ORDER BY created_at ASC`);
    return rows.map(toMemory);
  }

  async meta(): Promise<MemoryMeta> {
    const rows = await this.pg.query<{ last_consolidated_at: Date | null; pending_changes: number }>(
      `SELECT last_consolidated_at, pending_changes FROM memory_meta WHERE id = 1`
    );
    const row = rows[0];
    return {
      lastConsolidatedAt: row?.last_consolidated_at ? nowISO(row.last_consolidated_at) : null,
      pendingChanges: row?.pending_changes ?? 0,
    };
  }

  async saveMeta(meta: MemoryMeta): Promise<void> {
    await this.pg.query(
      `UPDATE memory_meta SET last_consolidated_at = $1, pending_changes = $2 WHERE id = 1`,
      [meta.lastConsolidatedAt, meta.pendingChanges]
    );
  }

  /**
   * 把一批改动落库
   *
   * 注意：整批在一个事务里。模型的一批操作往往是有关联的（先 update 再 delete），
   * 只成一半会让库处于中间状态——这和内存镜像里"整批校验再套用"是同一个道理。
   */
  async applyChanges(changes: MemoryChanges, meta: MemoryMeta): Promise<void> {
    await this.pg.transaction(async (client) => {
      for (const item of changes.upserts) {
        await client.query(
          `INSERT INTO memories (id, content, type, subjects, keywords, importance,
                                 due_at, created_at, updated_at, hits, last_used_at, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (id) DO UPDATE SET
             content = EXCLUDED.content,
             type = EXCLUDED.type,
             subjects = EXCLUDED.subjects,
             keywords = EXCLUDED.keywords,
             importance = EXCLUDED.importance,
             due_at = EXCLUDED.due_at,
             updated_at = EXCLUDED.updated_at,
             hits = EXCLUDED.hits,
             last_used_at = EXCLUDED.last_used_at,
             payload = EXCLUDED.payload`,
          toRow(item)
        );
      }
      if (changes.deletes.length) {
        await client.query(`DELETE FROM memories WHERE id = ANY($1)`, [changes.deletes]);
      }
      await client.query(
        `UPDATE memory_meta SET last_consolidated_at = $1, pending_changes = $2 WHERE id = 1`,
        [meta.lastConsolidatedAt, meta.pendingChanges]
      );
    });
  }

  /**
   * 只回写检索命中的强化信号
   *
   * 注意：单拎出来是因为它跑在检索路径上、频率高，而且只碰两个字段——
   * 没必要为了两个计数器把整条记录重写一遍
   */
  async markUsed(items: readonly MemoryItem[]): Promise<void> {
    if (!items.length) {
      return;
    }
    await this.pg.query(
      `UPDATE memories AS m SET hits = v.hits, last_used_at = v.last_used_at
       FROM (SELECT unnest($1::text[]) AS id,
                    unnest($2::int[]) AS hits,
                    unnest($3::timestamptz[]) AS last_used_at) AS v
       WHERE m.id = v.id`,
      [
        items.map((e) => e.id),
        items.map((e) => e.hits),
        items.map((e) => e.lastUsedAt),
      ]
    );
  }

  /**
   * 用一份全新的记忆库替换掉现有的（巩固用）
   */
  async replaceAll(items: readonly MemoryItem[], meta: MemoryMeta): Promise<void> {
    await this.pg.transaction(async (client) => {
      await client.query(`DELETE FROM memories`);
      for (const item of items) {
        await client.query(
          `INSERT INTO memories (id, content, type, subjects, keywords, importance,
                                 due_at, created_at, updated_at, hits, last_used_at, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          toRow(item)
        );
      }
      await client.query(
        `UPDATE memory_meta SET last_consolidated_at = $1, pending_changes = $2 WHERE id = 1`,
        [meta.lastConsolidatedAt, meta.pendingChanges]
      );
    });
  }

  async clear(): Promise<void> {
    await this.pg.transaction(async (client) => {
      await client.query(`DELETE FROM memories`);
      await client.query(
        `UPDATE memory_meta SET last_consolidated_at = NULL, pending_changes = 0 WHERE id = 1`
      );
    });
  }

  // ---- 提炼记录 ----

  async addExtraction(entry: NewExtraction): Promise<ExtractionRecord> {
    const rows = await this.pg.query<ExtractionRow>(
      `INSERT INTO extractions (kind, status, session_id, turn_ids, payload)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        entry.kind,
        entry.status,
        entry.sessionId ?? null,
        entry.turnIds ?? [],
        JSON.stringify({
          applied: entry.applied ?? [],
          stat: entry.stat,
          profileBefore: entry.profileBefore,
          profileAfter: entry.profileAfter,
          error: entry.error,
          reason: entry.reason,
        }),
      ]
    );
    return toExtraction(rows[0]!);
  }

  async listExtractions(query: ListExtractionsQuery): Promise<ExtractionRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.turnIds?.length) {
      params.push(query.turnIds);
      // && 是数组重叠：这条记录消化的轮次里有没有我要的
      where.push(`turn_ids && $${params.length}::bigint[]`);
    }
    if (query.sessionId) {
      params.push(query.sessionId);
      where.push(`session_id = $${params.length}`);
    }
    if (query.kind) {
      params.push(query.kind);
      where.push(`kind = $${params.length}`);
    }
    if (query.before) {
      params.push(query.before);
      where.push(`id < $${params.length}`);
    }
    params.push(query.limit);

    const rows = await this.pg.query<ExtractionRow>(
      `SELECT * FROM extractions
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY id DESC
       LIMIT $${params.length}`,
      params
    );
    return rows.map(toExtraction);
  }

  async pruneExtractions(days: number): Promise<number> {
    const rows = await this.pg.query(
      `DELETE FROM extractions WHERE created_at < now() - ($1 || ' days')::interval RETURNING id`,
      [String(days)]
    );
    return rows.length;
  }

  async clearExtractions(): Promise<void> {
    await this.pg.query(`DELETE FROM extractions`);
  }

  // ---- 快照（后悔药）----

  /**
   * 清空和巩固前拍一张快照
   *
   * 注意：这是原来 data/*.bak 文件的替代。一句话（还可能是语音识别错的）
   * 触发的不可逆操作是大忌，必须留一条退路。
   */
  async snapshot(reason: string, memories: readonly MemoryItem[], profile: string): Promise<void> {
    await this.pg.query(
      `INSERT INTO memory_snapshots (reason, memories, profile) VALUES ($1, $2, $3)`,
      [reason, JSON.stringify(memories), profile]
    );
  }

  async listSnapshots(limit: number) {
    const rows = await this.pg.query<{
      id: string;
      reason: string;
      created_at: Date;
      memories: MemoryItem[];
      profile: string;
    }>(
      `SELECT id, reason, created_at, memories, profile
       FROM memory_snapshots ORDER BY id DESC LIMIT $1`,
      [limit]
    );
    return rows.map((e) => ({
      id: String(e.id),
      reason: e.reason,
      createdAt: nowISO(e.created_at),
      count: e.memories.length,
      profile: e.profile,
    }));
  }
}

function toRow(item: MemoryItem): unknown[] {
  return [
    item.id,
    item.content,
    item.type,
    item.subjects,
    item.keywords,
    item.importance,
    item.dueAt,
    item.createdAt,
    item.updatedAt,
    item.hits,
    item.lastUsedAt,
    JSON.stringify({ evidence: item.evidence }),
  ];
}

function toMemory(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    content: row.content,
    type: row.type as MemoryItem["type"],
    subjects: row.subjects ?? [],
    keywords: row.keywords ?? [],
    importance: row.importance,
    dueAt: row.due_at,
    createdAt: nowISO(row.created_at),
    updatedAt: nowISO(row.updated_at),
    hits: row.hits,
    lastUsedAt: row.last_used_at ? nowISO(row.last_used_at) : null,
    evidence: row.payload?.evidence,
  };
}

function toExtraction(row: ExtractionRow): ExtractionRecord {
  return {
    id: String(row.id),
    kind: row.kind as ExtractionRecord["kind"],
    status: row.status as ExtractionRecord["status"],
    sessionId: row.session_id,
    turnIds: (row.turn_ids ?? []).map(String),
    createdAt: nowISO(row.created_at),
    applied: row.payload?.applied ?? [],
    stat: row.payload?.stat,
    profileBefore: row.payload?.profileBefore,
    profileAfter: row.payload?.profileAfter,
    error: row.payload?.error,
    reason: row.payload?.reason,
  };
}
