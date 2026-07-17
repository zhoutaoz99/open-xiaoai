/**
 * 一轮问答的流水记录
 *
 * 注意：放 Postgres 而不是文件，是因为前台要按对话翻页看历史——
 * 全文件扫描 + 内存里 filter 能用，但翻到第 50 页就得把 14 天的流水整个读一遍。
 */
export interface Turn {
  id: string;
  /**
   * 属于哪一段对话，见 Conversation
   */
  conversationId: string;
  sessionId: string;
  user: string;
  assistant: string;
  createdAt: string;
}

export interface TranscriptConfig {
  /**
   * 保留天数，0 表示不落流水（牺牲模式挖掘，前台也看不到对话记录）
   */
  days: number;
}

export interface ListTurnsQuery {
  sessionId?: string;
  /**
   * 只取这个 id 之前的（游标翻页）
   */
  before?: string;
  /**
   * 只取这段对话的轮次
   */
  conversationId?: string;
  limit: number;
}

/**
 * 一个会话的概览，给前台的会话列表用
 */
export interface SessionSummary {
  sessionId: string;
  turns: number;
  firstAt: string;
  lastAt: string;
}

/**
 * 一次对话
 *
 * 为什么要有它：协议里没有唤醒边界，session_id 由 migpt 的 AGENT_SESSION_ID
 * 固定给（默认就一个 default），所以「一次对话」不能靠 session_id 分——
 * 十天前问天气和刚才聊朵朵，是同一个 session_id 下的两条流水。
 *
 * 边界由 SessionService 定：**一次对话 = 一个会话窗口的生命周期**。
 * 窗口在用户开口时建、闲置 TTL 后过期（或被「重新开始」清掉），
 * 下次开口就是新的一段。id 在建窗口时就生成，每轮落库时一并写进 turns，
 * 所以段的归属是**当时**定下的事实，不是事后拿时间戳猜出来的——
 * 之后再改 TTL 也不会把历史重新切一遍。
 */
export interface Conversation {
  /**
   * 形如 c_lz4k8f3a，由 SessionService 生成
   */
  id: string;
  sessionId: string;
  /**
   * 首轮用户说的话，当标题用（落库时已截断）
   */
  title: string;
  turns: number;
  startedAt: string;
  endedAt: string;
}

export const TRANSCRIPT_CONFIG = Symbol("TRANSCRIPT_CONFIG");
