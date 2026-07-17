import { sleep } from "@mi-gpt/utils";
import OpenAI from "openai";
import { RustServer } from "./open-xiaoai.js";

export interface TTSConfig {
  /**
   * 语音合成服务的接口地址
   *
   * 支持兼容 OpenAI 接口的语音合成服务，比如：MiMo TTS 等
   *
   * 注意：一般以 /v1 结尾，不包含 /chat/completions 部分
   */
  baseURL?: string;
  /**
   * API 密钥
   */
  apiKey?: string;
  /**
   * 模型名称
   */
  model?: string;
  /**
   * 音色
   */
  voice?: string;
}

/**
 * 音频流格式：24kHz PCM16LE 单声道
 *
 * 注意：需要与 src/server.rs 里 start_play 的音频参数保持一致
 */
const kBytesPerSecond = 24000 * 2;

class TTSManager {
  private config?: Required<TTSConfig>;
  private client?: OpenAI;

  /**
   * 是否已开启自定义语音合成服务
   *
   * 注意：未开启时，会使用小爱音箱自带的语音合成服务
   */
  get enabled() {
    return this.client !== undefined;
  }

  init(config?: TTSConfig) {
    const { baseURL, apiKey, model, voice } = config ?? {};

    if (baseURL && apiKey && model && voice) {
      this.config = { baseURL, apiKey, model, voice };
      this.client = new OpenAI({ baseURL, apiKey });
      return;
    }

    // 配置不完整时，回退到小爱音箱自带的语音合成服务
    this.config = undefined;
    this.client = undefined;
    if (baseURL || apiKey || model || voice) {
      console.warn("⚠️ 语音合成配置不完整，已回退到小爱音箱自带的语音合成服务");
    }
  }

  /**
   * 合成文字并播放，等到音频播放完毕才会返回
   *
   * 注意：合成失败时只会返回 false，不会抛出异常
   */
  async play(text: string): Promise<boolean> {
    const { config, client } = this;
    if (!config || !client) {
      return false;
    }

    try {
      // 待合成的文字通过 assistant 消息传入，且音色不在 OpenAI 的类型定义内，所以这里需要转换类型
      const completion = (await client.chat.completions.create({
        model: config.model,
        messages: [{ role: "assistant", content: text }],
        audio: { format: "pcm16", voice: config.voice },
        stream: true,
      } as any)) as unknown as AsyncIterable<any>;

      let totalBytes = 0;
      let startTime = 0;

      for await (const chunk of completion) {
        const data = chunk.choices?.[0]?.delta?.audio?.data;
        if (!data) {
          continue;
        }
        const bytes = Buffer.from(data, "base64");
        if (!startTime) {
          startTime = Date.now();
        }
        totalBytes += bytes.length;
        const success = await RustServer.on_output_data(bytes);
        if (!success) {
          // 音箱未连接，无法播放音频流
          return false;
        }
      }

      if (!totalBytes) {
        return false;
      }

      // 音频流是边合成边播放的，这里等待音箱播放完剩余的音频
      const remaining =
        (totalBytes / kBytesPerSecond) * 1000 - (Date.now() - startTime);
      if (remaining > 0) {
        await sleep(remaining);
      }

      return true;
    } catch (e) {
      console.error("❌ 语音合成失败", e);
      return false;
    }
  }
}

export const TTS = new TTSManager();
