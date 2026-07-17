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
}

export interface SessionConfig {
  /**
   * 每个会话最多记住多少轮对话
   *
   * 注意：单位是「轮」，一轮 = 一问一答
   */
  maxTurns: number;
  /**
   * 会话闲置多久后清空（毫秒）
   */
  ttl: number;
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
   * 清空会话
   */
  reset(id: string) {
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
    this.gc();
    let session = this.sessions.get(id);
    if (!session) {
      session = { history: [], updatedAt: Date.now(), queue: Promise.resolve() };
      this.sessions.set(id, session);
    }
    session.updatedAt = Date.now();
    return session;
  }

  /**
   * 清理闲置过期的会话
   *
   * 注意：纯内存实现，不清理的话 Map 会一直涨
   */
  private gc() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.updatedAt > this.config.ttl) {
        this.sessions.delete(id);
      }
    }
  }
}
