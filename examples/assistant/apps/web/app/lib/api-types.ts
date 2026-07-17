/**
 * 与后端类型手动对齐
 *
 * 对应 apps/api/src/memory/memory.types.ts、transcript/transcript.types.ts、
 * soul/soul.types.ts。改后端的时候记得回来改这里。
 */

export type MemoryType = "profile" | "preference" | "fact" | "event" | "task" | "habit";

export interface MemoryItem {
  id: string;
  content: string;
  type: MemoryType;
  subjects: string[];
  keywords: string[];
  importance: number;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  hits: number;
  lastUsedAt: string | null;
  evidence?: string;
}

export type MemoryOp =
  | {
      op: "add";
      content: string;
      type: MemoryType;
      subjects: string[];
      keywords: string[];
      importance: number;
      dueAt: string | null;
      evidence?: string;
    }
  | {
      op: "update";
      id: string;
      content?: string;
      type?: MemoryType;
      subjects?: string[];
      keywords?: string[];
      importance?: number;
      dueAt?: string | null;
      evidence?: string;
    }
  | { op: "delete"; id: string }
  | {
      op: "merge";
      ids: string[];
      content?: string;
      type?: MemoryType;
      subjects?: string[];
      keywords?: string[];
      importance?: number;
      dueAt?: string | null;
    };

export interface MemoryStat {
  added: number;
  updated: number;
  deleted: number;
  merged: number;
}

export interface AppliedOp {
  op: MemoryOp;
  id?: string;
  content?: string;
}

export type ExtractionKind = "extract" | "consolidate";
export type ExtractionStatus = "ok" | "empty" | "failed";

export interface ExtractionRecord {
  id: string;
  kind: ExtractionKind;
  status: ExtractionStatus;
  sessionId: string | null;
  turnIds: string[];
  createdAt: string;
  applied: AppliedOp[];
  stat?: MemoryStat;
  profileBefore?: string;
  profileAfter?: string;
  error?: string;
  reason?: string;
}

export interface Turn {
  id: string;
  conversationId: string;
  sessionId: string;
  user: string;
  assistant: string;
  createdAt: string;
}

export interface SessionSummary {
  sessionId: string;
  turns: number;
  firstAt: string;
  lastAt: string;
}

/**
 * 一次对话 = 一个会话窗口的生命周期
 *
 * 注意：它不等于 session_id。session_id 由 migpt 的 AGENT_SESSION_ID 固定给，
 * 默认所有对话都是同一个 default——拿它当对话列表只会看到孤零零一项。
 * 段由后端在落库时就分好了，见 transcript/transcript.types.ts。
 */
export interface Conversation {
  id: string;
  sessionId: string;
  title: string;
  turns: number;
  startedAt: string;
  endedAt: string;
}

export interface SoulDocument {
  path: string;
  text: string;
  updatedAt: string | null;
  chars: number;
  maxChars?: number;
}

/**
 * 待办
 *
 * 注意：对应 apps/api/src/todo/todo.types.ts。dueAt 是**时刻**（带时区偏移），
 * 不是记忆里 event/task 那种日历日——主动提醒要精确到分。
 */
export type TodoStatus = "pending" | "done" | "cancelled";

export interface Todo {
  id: string;
  content: string;
  dueAt: string | null;
  remind: boolean;
  status: TodoStatus;
  firedAt: string | null;
  snoozedUntil: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySnapshot {
  id: string;
  reason: string;
  createdAt: string;
  count: number;
  profile: string;
}

export interface HealthInfo {
  status: string;
  memory: { enabled: boolean; size: number };
  sessions: number;
  transcript: boolean;
}

/**
 * 实时状态，给「对话与提炼」页 1 秒轮询用
 */
export interface StatusInfo {
  conversation: {
    /** 有活着的会话：正在应答，或答完还没闲置过期 */
    active: boolean;
    /** 模型正在应答这一句 */
    busy: boolean;
    /** 还有多少秒没新发言就巩固画像；应答中时为 null */
    idleInSeconds: number | null;
  };
  memory: {
    enabled: boolean;
    /** 正在巩固画像 */
    consolidating: boolean;
    /** 上次巩固以来还有多少条新记忆没进画像 */
    pendingChanges: number;
    lastConsolidatedAt: string | null;
  };
}
