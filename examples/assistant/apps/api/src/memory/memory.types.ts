import type { LLMConfig } from "../llm/llm.types";

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
export type MemoryType = "profile" | "preference" | "fact" | "event" | "task" | "habit";

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
   * event/task 可选：到期日期，形如 2026-07-18
   *
   * 注意：库里存的是 text 而不是 date。这是个日历日期，没有时区可言，
   * 而 new Date("2026-07-18") 会按 UTC 解析，东八区就会差出一天。
   * 存成字符串按字符串比，ISO 日期天然可比，谁都骗不了谁。
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

/**
 * 抽取器输出的操作
 *
 * 注意：这是大模型生成的内容，一律当作不可信输入校验，详见 ops.ts
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

export interface MemoryStat {
  added: number;
  updated: number;
  deleted: number;
  merged: number;
}

/**
 * 套用一批操作后，要落到 Postgres 上的改动
 *
 * 注意：内存镜像先改，再按这份清单落库。两边都成了才算数，
 * 落库失败会把镜像从库里重新载入（见 MemoryService.persist）。
 */
export interface MemoryChanges {
  upserts: MemoryItem[];
  deletes: string[];
}

/**
 * 一条操作落地后的结果，供前台展示
 *
 * 注意：光存 MemoryOp 不够——add 的 id 是落地时才生成的，
 * 而记忆日后可能被改被删。把当时的 id 和内容一起记下来，
 * 前台才能显示"这轮生成了哪几条记忆"，哪怕它现在已经没了。
 */
export interface AppliedOp {
  op: MemoryOp;
  /**
   * add 落地后拿到的 id；update/delete 的目标 id；merge 合并成的那条的 id
   */
  id?: string;
  /**
   * 操作发生时这条记忆的内容
   */
  content?: string;
}

/**
 * 提炼记录的种类
 *
 * - extract：每轮对话之后的当场抽取
 * - consolidate：睡眠式巩固（去重、清理、挖习惯、重写画像）
 */
export type ExtractionKind = "extract" | "consolidate";

/**
 * - ok：跑完了，且有产出
 * - empty：跑完了，但什么都没记（闲聊、百科——这是常态，不是故障）
 * - failed：调用或校验失败，整批丢弃
 */
export type ExtractionStatus = "ok" | "empty" | "failed";

/**
 * 一次提炼的记录：这轮对话让助手学到了什么
 *
 * 注意：它是给人看的审计流水，不参与任何模型调用。
 * 记忆系统最难排查的问题是"它为什么记成了这样"，
 * 而这个过程原本只在日志里一闪而过。
 */
export interface ExtractionRecord {
  id: string;
  kind: ExtractionKind;
  status: ExtractionStatus;
  sessionId: string | null;
  /**
   * 这次提炼消化了哪几轮对话
   *
   * 注意：是数组不是单个 id——抽取是批处理的，队列积压时
   * 一次调用会同时消化好几轮
   */
  turnIds: string[];
  createdAt: string;
  applied: AppliedOp[];
  stat?: MemoryStat;
  /**
   * 巩固才有：画像被改成了什么
   */
  profileBefore?: string;
  profileAfter?: string;
  /**
   * failed 时的原因
   */
  error?: string;
  reason?: string;
}

export interface ListExtractionsQuery {
  turnIds?: string[];
  sessionId?: string;
  kind?: ExtractionKind;
  before?: string;
  limit: number;
}

export interface MemoryConfig {
  /**
   * 记忆总开关，关闭后回到纯内存版
   */
  enabled: boolean;
  /**
   * 对话流水保留天数，0 表示不落流水
   */
  transcriptDays: number;
  /**
   * 提炼记录保留天数
   */
  extractionDays: number;
  /**
   * 单次检索最多返回多少条
   */
  recallTopK: number;
  /**
   * 单次检索结果的长度预算（字）
   */
  recallMaxChars: number;
  /**
   * 每个请求最多允许几轮带检索的模型往返
   *
   * 注意：数的是往返轮次，不是工具调用条数——模型可能在一轮里并行查好几个词
   */
  searchMaxCalls: number;
  /**
   * 记忆检索的传输方式
   *
   * - tools：标准 function calling
   * - marker：文本标记协议，给流式工具调用不稳的服务商兜底，语义完全一样
   */
  recallTransport: "tools" | "marker";
  /**
   * 检索时先播的填补话术，置空关闭
   */
  searchFiller?: string;
  /**
   * 画像预算（字）
   */
  profileMaxChars: number;
  /**
   * 每天几点兜底巩固一次，形如 03:00（本地时间）
   */
  consolidateAt: string;
  /**
   * 命中这些关键词时清空长期记忆（精确匹配）
   */
  wipeKeywords: string[];
  /**
   * 清空长期记忆后的回复话术
   */
  wipeText: string;
  /**
   * 抽取专用的大模型配置，可以用便宜的模型
   */
  openai: LLMConfig;
}

/**
 * 一轮完整的问答
 */
export interface Round {
  sessionId: string;
  /**
   * 这一轮属于哪段对话
   *
   * 注意：在用户开口时就取好了，不是落库时现算的——抽取是异步的，
   * 排到队的时候会话窗口可能早过期了，那会儿再问就是另一段了
   */
  conversationId: string;
  user: string;
  assistant: string;
  /**
   * 落库后的轮次 id，用来把提炼记录挂回这一轮
   *
   * 注意：可能没有——MEMORY_TRANSCRIPT_DAYS=0 时不落流水，
   * 但记忆照抽（用户说的话该记还得记，只是不留对话原文）
   */
  turnId?: string;
}

export const MEMORY_CONFIG = Symbol("MEMORY_CONFIG");

/**
 * 带本地时区偏移的 ISO 时间，形如 2026-07-17T09:30:00+08:00
 *
 * 注意：不用 toISOString()。库里存的是 timestamptz，读出来是 Date，
 * 到了前台要给人看——一个 UTC 时间戳会让所有人在心里做一次时区加减。
 * 提示词里也会带上它，模型同样不该做这道减法题。
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
