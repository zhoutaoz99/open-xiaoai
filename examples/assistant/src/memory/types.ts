/**
 * 记忆模块的共享类型
 */

/**
 * 记忆的种类
 *
 * - profile：身份、称呼、家庭成员
 * - preference：口味、喜好、习惯性偏好
 * - fact：客观事实（过敏、住址、工作）
 * - event：发生过或将要发生的事
 * - task：待办、约定
 * - habit：从流水里挖出来的重复模式（由定时巩固产出）
 */
export type MemoryType =
  | "profile"
  | "preference"
  | "fact"
  | "event"
  | "task"
  | "habit";

export const kMemoryTypes: MemoryType[] = [
  "profile",
  "preference",
  "fact",
  "event",
  "task",
  "habit",
];

export interface MemoryItem {
  /**
   * 形如 m_x7k2p9
   */
  id: string;
  /**
   * 一句话、自包含、第三人称
   */
  content: string;
  type: MemoryType;
  /**
   * 关于谁/什么，检索主键
   */
  subjects: string[];
  /**
   * 补充检索词，含常见别称（"女儿"和"朵朵"同挂）
   */
  keywords: string[];
  /**
   * 1~5，长期价值
   */
  importance: number;
  /**
   * event/task 可选：到期时间，形如 2026-07-18
   */
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * 被检索命中次数，强化信号
   */
  hits: number;
  lastUsedAt: string | null;
  /**
   * 原话摘录，仅供审计
   */
  evidence?: string;
}

/**
 * 巩固任务的元信息
 */
export interface MemoryMeta {
  /**
   * 上次巩固完成的时间
   */
  lastConsolidatedAt: string | null;
  /**
   * 上次巩固以来的记忆变更数
   *
   * 注意：既是兜底触发的依据（攒够了提前跑），也是空转跳过的依据（没变化就别烧钱）
   */
  pendingChanges: number;
}

export interface MemoryFile {
  version: number;
  memories: MemoryItem[];
  meta?: MemoryMeta;
}

/**
 * 抽取器输出的操作
 *
 * 注意：这是大模型生成的内容，一律当作不可信输入校验，详见 extractor.ts
 */
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
  /**
   * 把说的是同一件事的多条合并成一条（只有巩固任务会用）
   */
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

/**
 * 一轮完整的问答
 */
export interface Round {
  sessionId: string;
  user: string;
  assistant: string;
}

/**
 * 带本地时区偏移的 ISO 时间，形如 2026-07-17T09:30:00+08:00
 *
 * 注意：不用 toISOString()，因为这几份文件是给人看、给人改的，
 * 一个 UTC 时间戳会让所有人在心里做一次时区加减。
 */
export function nowISO(date = new Date()): string {
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  );
}

/**
 * 今天的日期，形如 2026-07-17
 */
export function today(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
