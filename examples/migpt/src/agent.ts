import { deepMerge } from "@mi-gpt/utils";
import { jsonDecode } from "@mi-gpt/utils/parse";
import { StreamResponse } from "@mi-gpt/stream";

export interface AgentConfig {
  /**
   * 外部对话服务的接口地址
   *
   * 注意：不包含 /chat 部分
   * - ✅ http://127.0.0.1:8000
   * - ❌ http://127.0.0.1:8000/chat
   */
  baseURL?: string;
  /**
   * API 密钥
   *
   * 注意：未配置时不会发送 Authorization 请求头
   */
  apiKey?: string;
  /**
   * 会话标识，外部服务据此维护多轮上下文
   */
  sessionId?: string;
  /**
   * 是否使用流式响应
   */
  stream?: boolean;
  /**
   * 首个事件（或完整响应）的超时时长（毫秒）
   */
  timeout?: number;
  /**
   * 调用失败时的兜底播报话术
   */
  errorText?: string;
}

interface ResolvedAgentConfig extends AgentConfig {
  baseURL: string;
  sessionId: string;
  stream: boolean;
  timeout: number;
  errorText: string;
}

export interface AgentReply {
  /**
   * 要播报的文字
   */
  text?: string;
  /**
   * 要播放的音频链接
   */
  url?: string;
  /**
   * 流式回复
   */
  stream?: StreamResponse;
  /**
   * 交回小爱原生回答
   */
  fallback?: boolean;
  /**
   * 被用户抢话打断，应该静默放弃
   */
  aborted?: boolean;
  /**
   * 外部服务对连续对话（唤醒状态）的显式意愿，见 examples/assistant/PROTOCOL.md 的 keep_awake
   *
   * 注意：`false` 表示本轮播完别再进连续对话（用户说了「关闭」之类的话）；
   * 缺省（undefined）表示外部服务没意见，由 keepAwake 配置自己决定。
   *
   * 注意：流式响应里 keep_awake 挂在 done 事件上，要等播报结束才收得到。
   * 所以这个字段是在后台 feed() 里回填的，判定连续对话时读的必须是同一个对象。
   */
  keepAwake?: boolean;
}

interface SSEEvent {
  event: string;
  data: string;
}

const kDefaultAgentConfig: AgentConfig = {
  sessionId: "default",
  stream: true,
  timeout: 10 * 1000,
  errorText: "出错了，请稍后再试吧",
};

/**
 * 整体超时时长（毫秒）
 *
 * 注意：只在流式响应中生效，防止外部服务发了一半就不动了
 */
const kTotalTimeout = 60 * 1000;

/**
 * 超时导致的中断原因，用来跟「用户抢话」导致的中断区分开
 */
const kTimeoutReason = "agent-timeout";

class AgentManager {
  private config?: ResolvedAgentConfig;
  private controller?: AbortController;

  /**
   * 是否已配置外部对话服务
   *
   * 注意：未配置时，所有消息都会交回小爱原生处理
   */
  get enabled() {
    return this.config !== undefined;
  }

  init(config?: AgentConfig) {
    const merged: AgentConfig = deepMerge(kDefaultAgentConfig, config);
    if (!merged.baseURL) {
      this.config = undefined;
      console.warn("⚠️ 未配置外部对话服务，所有消息都会交回小爱原生处理");
      return;
    }
    this.config = {
      ...merged,
      baseURL: merged.baseURL.replace(/\/+$/, ""),
    } as ResolvedAgentConfig;
  }

  /**
   * 健康检查
   */
  async health() {
    const { config } = this;
    if (!config) {
      return false;
    }
    try {
      const res = await fetch(`${config.baseURL}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5 * 1000),
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  /**
   * 取消正在进行的请求
   *
   * 注意：协议约定「连接即生命周期」，取消就是直接断开连接
   */
  cancel() {
    this.controller?.abort();
    this.controller = undefined;
  }

  /**
   * 把文字交给外部服务，返回它的回复
   *
   * 注意：出错时只会返回兜底话术，不会抛出异常
   */
  async chat(msg: {
    id: string;
    text: string;
    timestamp: number;
  }): Promise<AgentReply> {
    const { config } = this;
    if (!config) {
      return { fallback: true };
    }

    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(kTimeoutReason), config.timeout);

    try {
      const res = await fetch(`${config.baseURL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers() },
        body: JSON.stringify({
          request_id: msg.id,
          session_id: config.sessionId,
          text: msg.text,
          stream: config.stream,
          timestamp: msg.timestamp,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        console.error(`❌ 外部服务响应异常：HTTP ${res.status}`);
        return { text: config.errorText };
      }

      if (!config.stream) {
        const data = await res.json();
        return {
          text: data?.text,
          url: data?.url,
          fallback: data?.fallback,
          keepAwake: data?.keep_awake,
        };
      }

      if (!res.body) {
        console.error("❌ 外部服务没有返回响应体");
        return { text: config.errorText };
      }

      return await this.readStream(res.body, controller);
    } catch (e) {
      if (controller.signal.reason === kTimeoutReason) {
        console.error(`❌ 外部服务响应超时（${config.timeout}ms）`);
      } else if (controller.signal.aborted) {
        // 用户抢话，静默放弃
        return { aborted: true };
      } else {
        console.error("❌ 调用外部服务失败", e);
      }
      return { text: config.errorText };
    } finally {
      // 只保护到首个事件为止，后面由 feed() 里的整体超时接管
      clearTimeout(timer);
    }
  }

  private headers(): Record<string, string> {
    const { apiKey } = this.config ?? {};
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  /**
   * 读取流式响应
   *
   * 注意：只等到首个事件就返回，剩下的在后台边收边喂给 StreamResponse，
   * 这样引擎才能立刻开始分句播报。
   */
  private async readStream(
    body: ReadableStream<Uint8Array>,
    controller: AbortController
  ): Promise<AgentReply> {
    const { config } = this;
    const events = parseSSE(body);

    // 协议约定 fallback 必须在任何 delta 之前发送，所以看首个事件就够了
    const first = await events.next();
    if (first.done) {
      console.error("❌ 外部服务没有返回任何事件");
      return { text: config?.errorText };
    }

    const event = first.value;
    if (event.event === "fallback") {
      await events.return(undefined);
      return { fallback: true };
    }
    if (event.event === "error") {
      const data = jsonDecode<{ message?: string; text?: string }>(event.data);
      console.error("❌ 外部服务返回错误", data?.message);
      await events.return(undefined);
      return { text: data?.text || config?.errorText };
    }

    const stream = new StreamResponse();
    // keep_awake 在 done 事件上，等播报结束才收得到，所以先返回这个对象，
    // 再让后台的 feed() 往它身上回填 keepAwake——判定连续对话时读的是同一个引用
    const reply: AgentReply = { stream };
    this.write(stream, event);
    this.feed(events, stream, controller, reply);
    return reply;
  }

  /**
   * 在后台把剩下的事件喂给 StreamResponse
   */
  private async feed(
    events: AsyncGenerator<SSEEvent>,
    stream: StreamResponse,
    controller: AbortController,
    reply: AgentReply
  ) {
    const timer = setTimeout(() => controller.abort(kTimeoutReason), kTotalTimeout);
    try {
      for await (const event of events) {
        if (stream.status === "canceled") {
          // 用户抢话，引擎已经取消了播报，这里断开连接通知外部服务停止生成
          controller.abort();
          return;
        }
        if (event.event === "delta") {
          this.write(stream, event);
        } else if (event.event === "error") {
          const data = jsonDecode<{ message?: string }>(event.data);
          console.error("❌ 外部服务返回错误", data?.message);
          break;
        } else if (event.event === "done") {
          reply.keepAwake = jsonDecode<{ keep_awake?: boolean }>(event.data)?.keep_awake;
          break;
        }
      }
      // 把已经收到的内容播完
      stream.flush();
    } catch (e) {
      if (controller.signal.reason === kTimeoutReason) {
        console.error(`❌ 外部服务响应中断超时（${kTotalTimeout}ms）`);
      } else if (!controller.signal.aborted) {
        console.error("❌ 读取外部服务响应失败", e);
      }
      stream.cancel();
    } finally {
      clearTimeout(timer);
    }
  }

  private write(stream: StreamResponse, event: SSEEvent) {
    if (event.event !== "delta") {
      return;
    }
    const text = jsonDecode<{ text?: string }>(event.data)?.text;
    if (text) {
      stream.write(text);
    }
  }
}

/**
 * 解析 SSE 响应流
 */
async function* parseSSE(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) {
          break;
        }
        const event = parseSSEEvent(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (event) {
          yield event;
        }
      }
    }
    // 兼容最后一个事件没有以空行结尾的情况
    const event = parseSSEEvent(buffer);
    if (event) {
      yield event;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function parseSSEEvent(raw: string): SSEEvent | undefined {
  let event = "";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    // 空行和以 : 开头的注释行都要跳过
    if (!line || line.startsWith(":")) {
      continue;
    }
    const index = line.indexOf(":");
    const field = index === -1 ? line : line.slice(0, index);
    const value = index === -1 ? "" : line.slice(index + 1).replace(/^ /, "");
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  // 协议约定事件都是具名的，没有 event 字段的一律忽略
  return event ? { event, data: data.join("\n") } : undefined;
}

export const Agent = new AgentManager();
