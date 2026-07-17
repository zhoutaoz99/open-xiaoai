/**
 * 待办的状态机
 *
 * - pending：待办，可能还没到点、也可能到点播报过了（看 firedAt）
 * - done：已完成（用户说"做完了"，或前台点了完成）
 * - cancelled：已取消（用户说"算了"）
 */
export type TodoStatus = "pending" | "done" | "cancelled";

/**
 * 一条待办
 *
 * 注意：这和记忆里的 event/task 是两回事，别混。记忆的 dueAt 是**日历日**
 * （text，无时区），表达"哪天"；待办的 dueAt 是**时刻**（timestamptz），
 * 表达"几点几分播报"——主动提醒要精确到分，日期字符串不够用。
 * 对外一律用带本地时区偏移的 ISO 字符串（nowISO），不用 toISOString()。
 */
export interface Todo {
  /**
   * 形如 t_x7k2p9
   */
  id: string;
  /**
   * 要做/要提醒的事，一句话
   */
  content: string;
  /**
   * 播报时刻，形如 2026-07-18T15:00:00+08:00；无时间的纯清单项为 null
   */
  dueAt: string | null;
  /**
   * 到点是否主动播报
   *
   * 注意：这是通用 todo 系统给不了的一栏，也是"主动提醒"和"随手记一条"的分界。
   * "提醒我三点开会" → true；"记一下要买牛奶" → false（只进清单，不打扰）。
   */
  remind: boolean;
  status: TodoStatus;
  /**
   * 播报后写入。触发幂等的关键：非空就不再 fire
   */
  firedAt: string | null;
  /**
   * 贪睡到此刻前不 fire
   */
  snoozedUntil: string | null;
  /**
   * 谁建的：voice（音箱）| web（前台）
   */
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewTodo {
  content: string;
  /**
   * ISO 时刻。可能只给了日期没给时刻（"明天提醒我买菜"），由 TodoService
   * 补上默认时刻（见 TodoConfig.defaultTime）
   */
  dueAt?: string | null;
  remind?: boolean;
  source?: string;
}

export interface TodoPatch {
  content?: string;
  dueAt?: string | null;
  remind?: boolean;
  status?: TodoStatus;
}

export interface TodoFilter {
  status?: TodoStatus;
}

export interface TodoConfig {
  /**
   * 待办总开关，关了不挂工具、不启动调度器
   */
  enabled: boolean;
  /**
   * migpt 的推送地址，形如 http://127.0.0.1:4400
   *
   * 注意：没配则提醒只打日志（功能降级不报错），见 notifier.ts。
   * 这条通道早在 examples/migpt/PROTOCOL.md 里定义好了，本模块只是第一次用它。
   */
  pushUrl?: string;
  /**
   * 推送鉴权，要和 migpt 的 AGENT_PUSH_API_KEY 一致
   */
  pushApiKey?: string;
  /**
   * 调度器扫描间隔（秒）
   */
  scanSeconds: number;
  /**
   * 迟到多久就不再补播（分钟）
   *
   * 注意：migpt 断线一段时间再恢复，不该把积压的提醒一口气全念了。
   * 迟到超过这个时长的直接标记跳过，不播。
   */
  maxLateMinutes: number;
  /**
   * 只给了日期没给时刻的待办，默认几点提醒，形如 09:00（本地时间）
   */
  defaultTime: string;
}

export const TODO_CONFIG = Symbol("TODO_CONFIG");

/**
 * 生成待办 id，形如 t_x7k2p9
 *
 * 注意：和记忆的 m_ 前缀对齐，一眼能看出是哪种东西
 */
export function newTodoId(): string {
  return `t_${Math.random().toString(36).slice(2, 8)}`;
}
