import { sleep } from "@mi-gpt/utils";
import { Agent } from "./agent.js";
import { envBoolean, envList, envNumber, envString } from "./env.js";
import { OpenXiaoAIConfig } from "./xiaoai.js";

/**
 * 只把这些关键词开头的消息转发给外部服务，其余交回小爱原生处理（在 .env 文件里配置）
 *
 * - 请问地球为什么是圆的？
 * - 你知道世界上跑的最快的动物是什么吗？
 *
 * 注意：留空表示全部转发
 */
const kCallKeywords = envList("AGENT_CALL_KEYWORDS") ?? [];

export const kOpenXiaoAIConfig: OpenXiaoAIConfig = {
  agent: {
    /**
     * 你的外部对话服务的接口地址（在 .env 文件里配置）
     *
     * 接口协议详见 PROTOCOL.md
     *
     * 注意：不包含 /chat 部分
     * - ✅ http://127.0.0.1:8000
     * - ❌ http://127.0.0.1:8000/chat
     */
    baseURL: envString("AGENT_BASE_URL"),
    /**
     * API 密钥（在 .env 文件里配置）
     *
     * 注意：未配置时不会发送 Authorization 请求头
     */
    apiKey: envString("AGENT_API_KEY"),
    /**
     * 会话标识（在 .env 文件里配置）
     *
     * 注意：多轮对话的上下文完全由外部服务维护，migpt 侧不保留任何记忆
     */
    sessionId: envString("AGENT_SESSION_ID"),
    /**
     * 是否使用流式响应（在 .env 文件里配置）
     */
    stream: envBoolean("AGENT_STREAM"),
    /**
     * 首个事件的超时时长，单位毫秒（在 .env 文件里配置）
     */
    timeout: envNumber("AGENT_TIMEOUT_MS"),
    /**
     * 调用失败时的兜底播报话术（在 .env 文件里配置）
     */
    errorText: envString("AGENT_ERROR_TEXT"),
  },
  push: {
    /**
     * 提醒推送服务监听的端口（在 .env 文件里配置）
     *
     * 外部服务可以 POST /push 主动推送提醒，接口协议详见 PROTOCOL.md
     *
     * 注意：未配置时不会启动推送服务
     */
    port: envNumber("AGENT_PUSH_PORT"),
    /**
     * 监听地址（在 .env 文件里配置）
     *
     * 注意：在 Docker 里运行时必须是 0.0.0.0，否则容器外访问不到
     */
    host: envString("AGENT_PUSH_HOST"),
    /**
     * 推送密钥（在 .env 文件里配置）
     *
     * 注意：未配置时不校验，同网络下任何人都能让音箱说话
     */
    apiKey: envString("AGENT_PUSH_API_KEY"),
  },
  tts: {
    /**
     * 你的语音合成服务提供商的接口地址（在 .env 文件里配置）
     *
     * 支持兼容 OpenAI 接口的语音合成服务，比如：MiMo TTS 等
     */
    baseURL: envString("TTS_BASE_URL"),
    /**
     * API 密钥（在 .env 文件里配置）
     *
     * 注意：未配置密钥时，会使用小爱音箱自带的语音合成服务
     */
    apiKey: envString("TTS_API_KEY"),
    /**
     * 模型名称（在 .env 文件里配置）
     */
    model: envString("TTS_MODEL"),
    /**
     * 音色（在 .env 文件里配置）
     */
    voice: envString("TTS_VOICE"),
  },
  /**
   * 回复播报完毕后进入连续对话，方便直接追问，不用再说一遍唤醒词（在 .env 文件里配置）
   *
   * 注意：默认关闭，且需要刷入开启了多轮对话的补丁固件，详见 packages/client-patch
   */
  keepAwake: envBoolean("KEEP_AWAKE"),
  /**
   * 关闭引擎内置的大模型问答
   *
   * 注意：置空后引擎不会再调用 askAI()，所有消息都由下面的 onMessage 接管，
   * 关键词过滤改用 kCallKeywords 自己实现。
   */
  callAIKeywords: [],
  /**
   * 把识别到的文字转发给外部服务，再把它返回的文字播报出来
   */
  async onMessage(engine, msg) {
    // 用户抢话时，取消上一条还没结束的请求
    Agent.cancel();

    if (!Agent.enabled) {
      return;
    }

    if (
      kCallKeywords.length &&
      !kCallKeywords.some((k) => msg.text.startsWith(k))
    ) {
      // 返回 undefined 表示交回小爱原生处理
      return;
    }

    // 必须先打断小爱，否则它会用自己的云端回答跟我们抢着说话
    await engine.speaker.abortXiaoAI();

    const reply = await Agent.chat(msg);

    if (reply.aborted) {
      // 用户抢话了，静默放弃这条回复
      return { handled: true };
    }

    if (reply.fallback) {
      // 上面已经把小爱打断了，这里要等它恢复运行才能重新提问
      await sleep(2000);
      await engine.speaker.askXiaoAI(msg.text);
      return { handled: true };
    }

    // 直接把 reply 交给引擎，而不是另建对象：流式下 keepAwake 要等播报结束
    // 才由 feed() 回填，必须是同一个引用，shouldKeepAwake 才读得到（见 agent.ts）。
    // reply 的字段是 IReply 的超集，多出来的 keepAwake 引擎会忽略。
    return reply;
  },
};
