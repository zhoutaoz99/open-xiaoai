import type { TodoConfig } from "./todo.types";

/**
 * 提醒的对外投递：唯一一处助手主动够到外部世界的地方
 *
 * 注意：抽成接口是为了保持解耦——生产环境打 migpt 的推送通道，
 * 没配推送时降级成只打日志，将来也能换成别的 webhook。
 */
export interface Notifier {
  push(text: string): Promise<void>;
}

export const NOTIFIER = Symbol("NOTIFIER");

/**
 * 打 migpt 的推送通道：POST {pushUrl}/push
 *
 * 注意：协议见 PROTOCOL.md 第十节。202 表示"已接受"不是
 * "已播报"——音箱离线时 migpt 只在自己那边打日志，不会回传失败。所以能拿到
 * 一个非 2xx 之外的响应就算投递成功了，调度器据此 markFired。
 */
export class MigptPushNotifier implements Notifier {
  constructor(
    private url: string,
    private apiKey?: string
  ) {}

  async push(text: string): Promise<void> {
    const res = await fetch(`${this.url.replace(/\/$/, "")}/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      // 4xx/5xx：鉴权不对、参数不对、推送服务没起。抛出去让调度器不 markFired、
      // 下一轮重试（迟到超上限才会放弃）
      throw new Error(`推送失败 HTTP ${res.status}`);
    }
  }
}

/**
 * 没配 AGENT_PUSH_URL 时的降级实现：只打日志
 *
 * 注意：这样待办功能照常能记、能查、能管，只是提醒不出声——
 * 保持"未配置只打日志、不报错"的解耦语义
 */
export class LogNotifier implements Notifier {
  async push(text: string): Promise<void> {
    console.log(`🔔 [提醒·未配置推送] ${text}`);
  }
}

export function createNotifier(config: TodoConfig): Notifier {
  return config.pushUrl
    ? new MigptPushNotifier(config.pushUrl, config.pushApiKey)
    : new LogNotifier();
}
