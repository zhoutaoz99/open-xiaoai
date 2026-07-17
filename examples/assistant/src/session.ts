export interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Session {
  history: Message[];
  updatedAt: number;
  /**
   * 同一会话的请求队列，详见 lock()
   */
  queue: Promise<unknown>;
  /**
   * 闲置计时器，详见 arm()
   */
  timer?: NodeJS.Timeout;
}

export interface SessionConfig {
  /**
   * 每个会话最多记住多少轮对话
   *
   * 注意：单位是「轮」，一轮 = 一问一答。
   * 这是安全阀不是目标——真正决定对话有多长的是 ttl。
   */
  maxTurns: number;
  /**
   * 会话闲置多久后清空（毫秒）
   *
   * 注意：这就是"一轮对话结束"的判定——协议里没有唤醒边界，
   * 说完话隔了这么久没下文，就算这轮聊完了
   */
  ttl: number;
  /**
   * 会话闲置到期、被清空时回调
   *
   * 注意：这是「用户不说话了」的时刻，长期记忆拿它当睡眠信号
   */
  onExpire?: (id: string) => void;
}

/**
 * 纯内存的多轮对话上下文
 *
 * 注意：没有任何持久化，进程重启即清空
 */
export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(private config: SessionConfig) {}

  get size() {
    return this.sessions.size;
  }

  /**
   * 取出会话历史
   *
   * 注意：返回的是内部数组，调用方只读，不要直接改
   */
  history(id: string): readonly Message[] {
    return this.touch(id).history;
  }

  /**
   * 记录一轮完整的问答
   *
   * 注意：提问和回复成对写入、成对淘汰。如果按「条」淘汰，
   * 窗口边缘会留下没有提问的孤儿回复，白占一个槽位。
   */
  append(id: string, user: string, assistant: string) {
    const session = this.touch(id);
    session.history.push(
      { role: "user", content: user },
      { role: "assistant", content: assistant }
    );
    while (session.history.length > this.config.maxTurns * 2) {
      session.history.splice(0, 2);
    }
  }

  /**
   * 清空会话（用户主动说"重新开始"）
   *
   * 注意：不触发 onExpire。人还在跟前坐着，这不是"对话结束"，
   * 是他想换个话题重来
   */
  reset(id: string) {
    const session = this.sessions.get(id);
    clearTimeout(session?.timer);
    this.sessions.delete(id);
  }

  /**
   * 让同一个会话的请求排队执行
   *
   * 注意：用户抢话时，migpt 会先断开上一条请求再发新的，
   * 两条请求可能在服务端交叠。不串行化的话，历史会写成乱序。
   */
  async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const session = this.touch(id);
    const task = session.queue.then(fn, fn);
    // 前一条请求失败不能卡住后面的
    session.queue = task.catch(() => undefined);
    return task;
  }

  private touch(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = { history: [], updatedAt: Date.now(), queue: Promise.resolve() };
      this.sessions.set(id, session);
    }
    session.updatedAt = Date.now();
    this.arm(id, session);
    return session;
  }

  /**
   * 重置闲置计时：每说一句话就往后推
   *
   * 注意：这里用真定时器，而不是等下次请求来了再顺手清（懒惰过期）。
   * 懒惰过期下"对话结束"这个时刻根本不存在——会话是在用户
   * 下次开口时才被清掉的，那时人已经在说下一句了，
   * 也就没法拿它当"用户安静下来了"的信号。
   */
  private arm(id: string, session: Session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.expire(id), this.config.ttl);
    // 别因为等一个会话过期就让进程退不出去
    session.timer.unref();
  }

  private expire(id: string) {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    clearTimeout(session.timer);
    this.sessions.delete(id);
    console.log(`💤 [${id}] 闲置 ${Math.round(this.config.ttl / 60000)} 分钟，本轮对话结束`);
    this.config.onExpire?.(id);
  }
}
