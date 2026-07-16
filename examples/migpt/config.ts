import { sleep } from "@mi-gpt/utils";
import { envString, getOpenAICreateParams } from "./migpt/env.js";
import { OpenXiaoAIConfig } from "./migpt/xiaoai.js";

export const kOpenXiaoAIConfig: OpenXiaoAIConfig = {
  openai: {
    /**
     * 你的大模型服务提供商的接口地址（在 .env 文件里配置）
     *
     * 支持兼容 OpenAI 接口的大模型服务，比如：DeepSeek V3 等
     *
     * 注意：一般以 /v1 结尾，不包含 /chat/completions 部分
     * - ✅ https://api.openai.com/v1
     * - ❌ https://api.openai.com/v1/（最后多了一个 /
     * - ❌ https://api.openai.com/v1/chat/completions（不需要加 /chat/completions）
     */
    baseURL: envString("OPENAI_BASE_URL"),
    /**
     * API 密钥（在 .env 文件里配置）
     */
    apiKey: envString("OPENAI_API_KEY"),
    /**
     * 模型名称（在 .env 文件里配置）
     */
    model: envString("OPENAI_MODEL"),
    extra: {
      /**
       * 思考模式、温度等额外的请求参数（在 .env 文件里配置）
       */
      createParams: getOpenAICreateParams(),
    },
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
  prompt: {
    /**
     * 系统提示词，如需关闭可设置为：''（空字符串）
     */
    system: "你是一个智能助手，请根据用户的问题给出回答。",
  },
  context: {
    /**
     * 每次对话携带的最大历史消息数（如需关闭可设置为：0）
     */
    historyMaxLength: 10,
  },
  /**
   * 只回答以下关键词开头的消息：
   *
   * - 请问地球为什么是圆的？
   * - 你知道世界上跑的最快的动物是什么吗？
   */
  callAIKeywords: ["请", "你"],
  /**
   * 自定义消息回复
   */
  async onMessage(engine, { text }) {
    if (text === "测试播放文字") {
      return { text: "你好，很高兴认识你！" };
    }

    if (text === "测试播放音乐") {
      return { url: "https://example.com/hello.mp3" };
    }

    if (text === "测试其他能力") {
      // 打断原来小爱的回复
      await engine.speaker.abortXiaoAI();

      // 播放文字
      await sleep(2000); // 打断小爱后需要等待 2 秒，使其恢复运行后才能继续 TTS
      await engine.speaker.play({ text: "你好，很高兴认识你！", blocking: true });

      // 播放音频链接
      await engine.speaker.play({ url: "https://example.com/hello.mp3" });

      // 告诉 MiGPT 已经处理过这条消息了，不再使用默认的 AI 回复
      return { handled: true };
    }
  },
};
