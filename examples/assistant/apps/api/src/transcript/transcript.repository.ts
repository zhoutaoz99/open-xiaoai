import { Injectable } from "@nestjs/common";
import { PostgresService } from "../data/postgres.service";
import { nowISO } from "../memory/memory.types";
import type { Conversation, ListTurnsQuery, SessionSummary, Turn } from "./transcript.types";

interface TurnRow {
  id: string;
  conversation_id: string | null;
  session_id: string;
  user_text: string;
  assistant_text: string;
  created_at: Date;
}

interface ConversationRow {
  id: string;
  session_id: string;
  title: string;
  turns: number;
  started_at: Date;
  ended_at: Date;
}

/**
 * 标题最长留多少字：首轮问话，语音说出来的一句，通常远短于此
 */
const kTitleMaxChars = 60;

@Injectable()
export class TranscriptRepository {
  constructor(private pg: PostgresService) {}

  /**
   * 落一轮，并把它算进所属的那段对话
   *
   * 两件事在一个事务里：轮次进去了但段没更新（或反过来）会让前台
   * 看到一段轮数对不上的对话，或者一条挂在不存在的段上的轮次。
   */
  async insert(
    conversationId: string,
    sessionId: string,
    user: string,
    assistant: string
  ): Promise<Turn> {
    return this.pg.transaction(async (client) => {
      // 段的第一轮建段，之后每轮把轮数和结束时间往前推。
      // 标题只在建段时写，ON CONFLICT 不动它——一段对话的名字是
      // 用户开口第一句话，不该被后面的话顶掉
      await client.query(
        // turns 显式写 1，别指望列默认值——建段的这一刻就已经有一轮了，
        // 默认值 0 会让每段都少算一轮，而且只有第二轮起才走 ON CONFLICT 补不回来
        `INSERT INTO conversations (id, session_id, title, turns)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (id) DO UPDATE
           SET turns    = conversations.turns + 1,
               ended_at = now()`,
        [conversationId, sessionId, user.slice(0, kTitleMaxChars)]
      );

      const { rows } = await client.query<TurnRow>(
        `INSERT INTO turns (conversation_id, session_id, user_text, assistant_text)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [conversationId, sessionId, user, assistant]
      );
      return toTurn(rows[0]!);
    });
  }

  /**
   * 取保留期内的流水，按时间正序（巩固任务要的是"先后顺序"）
   */
  async recent(days: number, limit: number): Promise<Turn[]> {
    const rows = await this.pg.query<TurnRow>(
      `SELECT * FROM (
         SELECT * FROM turns
         WHERE created_at >= now() - ($1 || ' days')::interval
         ORDER BY created_at DESC, id DESC
         LIMIT $2
       ) t ORDER BY created_at ASC, id ASC`,
      [String(days), limit]
    );
    return rows.map(toTurn);
  }

  /**
   * 翻页列出轮次，按时间倒序（前台要的是"最近的在前"）
   */
  async list(query: ListTurnsQuery): Promise<Turn[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.sessionId) {
      params.push(query.sessionId);
      where.push(`session_id = $${params.length}`);
    }
    if (query.before) {
      params.push(query.before);
      where.push(`id < $${params.length}`);
    }
    if (query.conversationId) {
      params.push(query.conversationId);
      where.push(`conversation_id = $${params.length}`);
    }
    params.push(query.limit);

    const rows = await this.pg.query<TurnRow>(
      `SELECT * FROM turns
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY id DESC
       LIMIT $${params.length}`,
      params
    );
    return rows.map(toTurn);
  }

  async sessions(): Promise<SessionSummary[]> {
    const rows = await this.pg.query<{
      session_id: string;
      turns: string;
      first_at: Date;
      last_at: Date;
    }>(
      `SELECT session_id,
              count(*)        AS turns,
              min(created_at) AS first_at,
              max(created_at) AS last_at
       FROM turns
       GROUP BY session_id
       ORDER BY max(created_at) DESC`
    );
    return rows.map((e) => ({
      sessionId: e.session_id,
      turns: Number(e.turns),
      firstAt: nowISO(e.first_at),
      lastAt: nowISO(e.last_at),
    }));
  }

  /**
   * 列出一段段对话，最近的在前
   *
   * 段是落库时就分好的（见 Conversation），这里只是把行读出来——
   * 不聚合、不推导，一个索引扫过去就完事
   */
  async conversations(limit: number): Promise<Conversation[]> {
    const rows = await this.pg.query<ConversationRow>(
      `SELECT * FROM conversations
       ORDER BY started_at DESC, id DESC
       LIMIT $1`,
      [limit]
    );
    return rows.map(toConversation);
  }

  /**
   * 删掉保留期以外的
   *
   * 注意：按「段」淘汰，不按「轮」。一次对话是个整体，从中间切一刀会留下
   * 一段没头没尾读不懂的下半场，而且 conversations.turns 这个计数
   * 也会跟着变成假的。轮次靠外键级联跟着走。
   */
  async prune(days: number): Promise<{ turns: number; conversations: number }> {
    const rows = await this.pg.query<{ turns: string; conversations: string }>(
      `WITH gone AS (
         DELETE FROM conversations
         WHERE ended_at < now() - ($1 || ' days')::interval
         RETURNING turns
       )
       SELECT COALESCE(sum(turns), 0) AS turns, count(*) AS conversations FROM gone`,
      [String(days)]
    );
    return {
      turns: Number(rows[0]?.turns ?? 0),
      conversations: Number(rows[0]?.conversations ?? 0),
    };
  }

  async clear(): Promise<void> {
    // 段没了轮次也就没了（外键级联），但反过来不成立，所以两张都得清
    await this.pg.query(`DELETE FROM turns`);
    await this.pg.query(`DELETE FROM conversations`);
  }
}

function toTurn(row: TurnRow): Turn {
  return {
    id: String(row.id),
    conversationId: row.conversation_id ?? "",
    sessionId: row.session_id,
    user: row.user_text,
    assistant: row.assistant_text,
    createdAt: nowISO(row.created_at),
  };
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    turns: Number(row.turns),
    startedAt: nowISO(row.started_at),
    endedAt: nowISO(row.ended_at),
  };
}
