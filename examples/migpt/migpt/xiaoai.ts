import { type EngineConfig, MiGPTEngine } from "@mi-gpt/engine";
import { deepMerge } from "@mi-gpt/utils";
import { jsonDecode } from "@mi-gpt/utils/parse";
import type { Prettify } from "@mi-gpt/utils/typing";
import { RustServer } from "./open-xiaoai.js";
import { OpenXiaoAISpeaker } from "./speaker.js";
import { TTS, type TTSConfig } from "./tts.js";
import { randomUUID } from "node:crypto";

export type OpenXiaoAIConfig = Prettify<
  EngineConfig<OpenXiaoAIEngine> & {
    /**
     * 语音合成（TTS）配置
     *
     * 如需使用小爱音箱自带的语音合成服务，可以删除该配置
     */
    tts?: TTSConfig;
  }
>;

const kDefaultOpenXiaoAIConfig: OpenXiaoAIConfig = {
  //
};

class OpenXiaoAIEngine extends MiGPTEngine {
  speaker = OpenXiaoAISpeaker;

  async start(config: OpenXiaoAIConfig) {
    const mergedConfig: OpenXiaoAIConfig = deepMerge(
      kDefaultOpenXiaoAIConfig,
      config
    );
    TTS.init(mergedConfig.tts);
    await super.start(mergedConfig);
    // 注册全局回调函数
    (global as any).RUST_CALLBACKS = {
      on_event: this.onEvent,
      on_input_data: this.onRecord,
    };
    // 启动服务
    console.log("✅ 服务已启动...");
    await RustServer.start();
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
