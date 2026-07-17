import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { SESSION_CONFIG, type Message, type SessionConfig } from "./chat.types";

interface Session {
  history: Message[];
  updatedAt: number;
  /**
   * 这次对话的 id，详见 conversationId()
   */
  conversationId: string;
  /**
   * 正在处理的请求数。>0 时这个会话不算闲置——详见 arm()
   *
   * 注意：用计数不用布尔。抢话时 migpt 会断开旧请求、发来新的，两条可能
   * 在服务端交叠，得等最后一条做完才开始算闲置。
   */
  inFlight: number;
  /**
   * 同一会话的请求队列，详见 lock()
   */
  queue: Promise<unknown>;
  /**
   * 闲置计时器，详见 arm()
   */
  timer?: NodeJS.Timeout;
}

/**
 * 纯内存的多轮对话上下文
 *
 * 注意：没有任何持久化，进程重启即清空——即使记忆库和对话流水已经进了
 * Postgres，这里依然是内存。会话窗口是"这次对话的流"，不是记忆：
 * 值得留下的东西每轮都会被抽取进长期记忆，窗口本身没有留存价值。
 * 这也正是每轮都要当场抽取的原因——经历转瞬即逝，等不到定时任务。
 */
@Injectable()
export class SessionService implements OnApplicationShutdown {
  private sessions = new Map<string, Session>();
  private onExpireHandler?: (id: string) => void;

  constructor(@Inject(SESSION_CONFIG) private config: SessionConfig) {}

  get size() {
    return this.sessions.size;
  }

  /**
   * 只读快照，给前台状态轮询用
   *
   * 注意：纯观测——不 touch、不改任何计时。返回：还活着几个会话、有没有
   * 会话正在应答（inFlight），以及最近一个会话还有多久闲置到期（触发巩固）。
   * idleInMs 是所有"已经不在应答、正在倒计时"的会话里最快到期的那个，
   * 默认单会话时就是它本身；应答中的会话不参与（它没有在倒计时）。
   */
  status(): { active: number; busy: boolean; idleInMs: number | null } {
    const now = Date.now();
    let busy = false;
    let idleInMs: number | null = null;
    for (const session of this.sessions.values()) {
      if (session.inFlight > 0) {
        busy = true;
        continue;
      }
      const remaining = session.updatedAt + this.config.ttl - now;
      if (idleInMs === null || remaining < idleInMs) {
        idleInMs = remaining;
      }
    }
    return { active: this.sessions.size, busy, idleInMs };
  }

  /**
   * 注册"用户不说话了"的回调
   *
   * 注意：这里不直接依赖记忆模块，由 ChatService 在启动时把两者接起来——
   * 会话窗口不该知道长期记忆的存在，它只负责喊一嗓子"这轮聊完了"。
   */
  onExpire(fn: (id: string) => void) {
    this.onExpireHandler = fn;
  }

  onApplicationShutdown() {
    for (const session of this.sessions.values()) {
      clearTimeout(session.timer);
    }
    this.sessions.clear();
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
   * 这次对话的 id
   *
   * **一次对话 = 一个会话窗口的生命周期**。窗口在用户开口时建、闲置 TTL 后
   * 过期（或被「重新开始」清掉），下次开口 touch() 会建一个新窗口、
   * 连带一个新的 id——所以段的边界就是这里，不需要谁去比对时间戳猜。
   *
   * 会话窗口本身依然是纯内存的，这个 id 只是随每轮问答一起落进 turns，
   * 好让前台把一次对话完整地拼回来。
   */
  conversationId(id: string): string {
    return this.touch(id).conversationId;
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
    // 进入处理：暂停闲置倒计时。一轮问答（模型思考 + 检索 + 生成）可能比
    // TTL 还久，这段时间不是"用户走开了"，不能拿来算闲置——见 arm()。
    session.inFlight++;
    clearTimeout(session.timer);
    session.timer = undefined;
    const task = session.queue.then(fn, fn);
    // 前一条请求失败不能卡住后面的
    session.queue = task.catch(() => undefined);
    try {
      return await task;
    } finally {
      // 最后一条请求做完了，从现在起算闲置。中途被 reset() 换掉的旧会话
      // 不要再武装（它已经不在表里，武装了只会误伤新会话）
      if (--session.inFlight === 0 && this.sessions.get(id) === session) {
        session.updatedAt = Date.now();
        this.arm(id, session);
      }
    }
  }

  private touch(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        history: [],
        updatedAt: Date.now(),
        conversationId: newConversationId(),
        inFlight: 0,
        queue: Promise.resolve(),
      };
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
    session.timer = undefined;
    // 请求还在处理时不计闲置。慢一点的一轮（模型思考、检索、语音合成都要
    // 时间）会比 TTL 还久，这段时间里没有 touch，定时器照走就会当场过期：
    // 下一句被切成新的一段对话，还会在这轮的抽取没跑完时就误触发一次巩固。
    // 所以处理中不设表，等 lock 的 finally 里 inFlight 归零再从头开始计时。
    if (session.inFlight > 0) {
      return;
    }
    session.timer = setTimeout(() => this.expire(id), this.config.ttl);
    // 别因为等一个会话过期就让进程退不出去
    session.timer.unref();
  }

  private expire(id: string) {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    // 定时器在请求刚进来的一瞬间擦身触发：这一轮还没做完，不能算闲置。
    // 什么都不做——lock 的 finally 会在做完后重新开始倒计时
    if (session.inFlight > 0) {
      return;
    }
    clearTimeout(session.timer);
    this.sessions.delete(id);
    console.log(`💤 [${id}] 闲置 ${Math.round(this.config.ttl / 60000)} 分钟，本轮对话结束`);
    this.onExpireHandler?.(id);
  }
}

/**
 * 形如 c_lz4k8f3a
 *
 * 注意：时间前缀 + 随机后缀，不查重。记忆库那边的 newId() 能查重是因为它有
 * 一份全量内存镜像；这里没有，也不该为了生成一个 id 去跑一趟 SQL——
 * 同一毫秒内还要再撞上同一个四位随机数才会重复，这个概率可以不谈。
 */
function newConversationId(): string {
  return `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
