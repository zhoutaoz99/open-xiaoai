import { type EngineConfig, MiGPTEngine } from "@mi-gpt/engine";
import type { IReply } from "@mi-gpt/engine/base";
import { deepMerge } from "@mi-gpt/utils";
import { jsonDecode } from "@mi-gpt/utils/parse";
import type { Prettify } from "@mi-gpt/utils/typing";
import { Agent, type AgentConfig, type AgentReply } from "./agent.js";
import { Push, type PushConfig } from "./push.js";
import { RustServer } from "./open-xiaoai.js";
import { OpenXiaoAISpeaker } from "./speaker.js";
import { TTS, type TTSConfig } from "./tts.js";
import { randomUUID } from "node:crypto";

/**
 * 引擎的消息类型
 *
 * 注意：它定义在 @mi-gpt/chat 里，而我们只依赖 @mi-gpt/engine，
 * 直接引 @mi-gpt/chat 的话 pnpm 下装不上，所以这里从引擎的方法签名上取。
 */
type EngineMessage = Parameters<MiGPTEngine["onMessage"]>[0];

export type OpenXiaoAIConfig = Prettify<
  EngineConfig<OpenXiaoAIEngine> & {
    /**
     * 语音合成（TTS）配置
     *
     * 如需使用小爱音箱自带的语音合成服务，可以删除该配置
     */
    tts?: TTSConfig;
    /**
     * 外部对话服务配置，接口协议详见 examples/assistant/PROTOCOL.md
     *
     * 如需交回小爱原生处理，可以删除该配置
     */
    agent?: AgentConfig;
    /**
     * 提醒推送服务配置，接口协议详见 examples/assistant/PROTOCOL.md
     *
     * 如需关闭外部服务主动推送提醒，可以删除该配置
     */
    push?: PushConfig;
    /**
     * 回复播报完毕后进入连续对话，方便用户直接追问，不用再说一遍唤醒词
     *
     * 音箱会自己放提示音、点灯，并保持约 7 秒的收音窗口（时长由固件决定），
     * 超时没人说话会自动退出。
     *
     * 注意：默认关闭，且需要刷入开启了多轮对话的补丁固件，详见 packages/client-patch。
     *
     * 注意：只有 onMessage 钩子返回回复（由我们自己播报）时才会进入连续对话，
     * 交回小爱原生处理的消息和外部服务推送的提醒都不会。
     */
    keepAwake?: boolean;
  }
>;

const kDefaultOpenXiaoAIConfig: OpenXiaoAIConfig = {
  keepAwake: false,
};

class OpenXiaoAIEngine extends MiGPTEngine {
  speaker = OpenXiaoAISpeaker;

  /**
   * 回复播报完毕后是否进入连续对话
   */
  private keepAwake = false;

  /**
   * onMessage 钩子对最近一条消息的处理结果
   *
   * 注意：引擎只有在钩子返回回复时才会播报，播报结束后据此判断要不要进入连续对话。
   * 消息是并发处理的（用户抢话），所以这里要连着消息 id 一起记。
   */
  private lastReply?: { id: string; reply?: IReply };

  async start(config: OpenXiaoAIConfig) {
    const mergedConfig: OpenXiaoAIConfig = deepMerge(
      kDefaultOpenXiaoAIConfig,
      config
    );
    this.keepAwake = mergedConfig.keepAwake ?? false;
    TTS.init(mergedConfig.tts);
    Agent.init(mergedConfig.agent);
    await super.start(mergedConfig);
    // 记下钩子的决定。super.start() 里又 merge 了一遍配置，所以要包装引擎最终持有的那个钩子
    const onMessage = this.config.onMessage;
    this.config.onMessage = async (engine, msg) => {
      const reply = await onMessage?.(engine, msg);
      this.lastReply = { id: msg.id, reply };
      return reply;
    };
    // 注册全局回调函数
    (global as any).RUST_CALLBACKS = {
      on_event: this.onEvent,
      on_input_data: this.onRecord,
    };
    // 探测外部对话服务，失败只告警，不阻塞启动
    if (Agent.enabled && !(await Agent.health())) {
      console.warn("⚠️ 外部对话服务健康检查未通过，请检查服务是否已启动");
    }
    // 启动提醒推送服务，接收外部服务主动推送的消息
    await Push.start(mergedConfig.push);
    // 启动服务
    console.log("✅ 服务已启动...");
    await RustServer.start();
  }

  /**
   * 收到用户消息
   *
   * 注意：引擎是逐句阻塞播报的，所以 super.onMessage() 返回时回复已经播完了，
   * 这里正好接着进入连续对话，让用户可以直接追问。
   */
  async onMessage(msg: EngineMessage) {
    await super.onMessage(msg);
    if (this.shouldKeepAwake(msg)) {
      // 提示音和灯效都由音箱自己负责，我们只要告诉它进入多轮对话就行
      if (await this.speaker.startMultiRounds()) {
        console.log("🔥 已进入连续对话，可以直接追问");
      } else {
        console.warn("⚠️ 进入连续对话失败，请检查音箱是否在线");
      }
    }
  }

  /**
   * 这条消息播报完毕后，要不要进入连续对话
   */
  private shouldKeepAwake(msg: EngineMessage) {
    if (!this.keepAwake) {
      return false;
    }
    if (this.lastMsg?.id !== msg.id) {
      // 用户抢话了，新消息已经在处理，交给它负责
      return false;
    }
    const { id, reply } = this.lastReply ?? {};
    if (id !== msg.id || !reply || reply.handled || reply.default) {
      // 钩子把消息交回小爱原生处理（或静默放弃）了，这会儿在说话的不是我们，不能抢
      return false;
    }
    if ((reply as AgentReply).keepAwake === false) {
      // 外部服务显式要求退出连续对话（用户说了「关闭」之类的话），
      // 哪怕这句告别有内容，也不再开收音窗口。见 examples/assistant/PROTOCOL.md 的 keep_awake。
      return false;
    }
    // 有内容引擎才会播报，没内容就没什么可追问的
    return !!(reply.text || reply.url || reply.stream);
  }

  /**
   * 收到事件
   */
  onEvent = (event: string) => {
    const e = JSON.parse(event);
    if (e.event === "playing") {
      // 更新播放状态
      OpenXiaoAISpeaker.status =
        e.data === "Playing"
          ? "playing"
          : e.data === "Paused"
          ? "paused"
          : "idle";
    } else if (e.event === "instruction" && e.data.NewLine) {
      // 收到语音识别结果
      const line = jsonDecode(e.data.NewLine);
      if (
        line?.header?.namespace === "SpeechRecognizer" &&
        line?.header?.name === "RecognizeResult" &&
        line?.payload?.is_final &&
        line?.payload?.results?.[0]?.text
      ) {
        const text = line.payload.results[0].text;
        this.onMessage({
          text,
          id: randomUUID(),
          sender: "user",
          timestamp: Date.now(),
        });
      }
    } else if (e.event === "kws") {
      const keyword = e.data;
      console.log("🔥 唤醒词识别", keyword);
    }
  };

  /**
   * 收到录音音频流
   */
  onRecord = (data: Uint8Array) => {
    console.log("🔥 收到录音音频流", data.length);
  };
}

export const OpenXiaoAI = new OpenXiaoAIEngine();
