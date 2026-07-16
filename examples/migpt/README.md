# Open-XiaoAI x MiGPT-Next

[Open-XiaoAI](https://github.com/idootop/open-xiaoai) 的 Node.js 版 Server 端，用来演示小爱音箱接入[MiGPT](https://github.com/idootop/mi-gpt)（完美版）。

相比原版的 `MiGPT` 和 `MiGPT-Next` 项目，该版本可以完美打断小爱音箱的回复，响应延迟更低，效果更完美 👍

> [!TIP]
> 想了解从唤醒到语音输出的完整链路（含架构图和时序图），请查看 [👉 端到端链路详解](./ARCHITECTURE.md)

## 快速开始

> [!NOTE]
> 继续下面的操作之前，你需要先在小爱音箱上启动运行 Rust 补丁程序 [👉 教程](../../packages/client-rust/README.md)

首先，克隆仓库代码到本地。

```shell
# 克隆代码
git clone https://github.com/idootop/open-xiaoai.git

# 进入当前项目根目录
cd examples/migpt
```

然后修改 `.env.example` 文件里的配置，并重命名为 `.env`。

```bash
# 大模型服务配置，对应 config.ts 里的 openai 配置

#你的大模型服务的 API 密钥
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx

#接口地址（一般以 /v1 结尾，不包含 /chat/completions 部分）
OPENAI_BASE_URL=https://api.deepseek.com

#模型名称
OPENAI_MODEL=deepseek-v4-flash

#温度：取值 0-2，值越大回复越随机（删除该配置则使用服务商的默认值）
OPENAI_TEMPERATURE=1

#思考模式：true 开启，false 关闭（删除该配置则使用服务商的默认值）
#注意：这是 DeepSeek 的参数格式，其他服务商可能不支持，此时请删除该配置
#注意：开启思考模式后，上面的温度配置不生效
OPENAI_THINKING=false


# 语音合成服务配置，对应 config.ts 里的 tts 配置

#你的语音合成服务的 API 密钥
#如需使用小爱音箱自带的语音合成服务，请删除该配置
TTS_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx

#接口地址
TTS_BASE_URL=https://api.xiaomimimo.com/v1

#模型名称
TTS_MODEL=mimo-v2.5-tts

#音色
TTS_VOICE=mimo_default
```

> [!TIP]
> `.env` 文件不会被提交到 Git 仓库，你的 API 密钥不会泄露。

提示词、自定义回复等其余配置，在 `config.ts` 文件里修改成你自己的。

```typescript
export const kOpenXiaoAIConfig = {
  prompt: {
    system: "你是一个智能助手，请根据用户的问题给出回答。",
  },
  async onMessage(engine, { text }) {
    if (text === "测试") {
      return { text: "你好，很高兴认识你！" };
    }
  },
};
```

### Docker 运行

[![Docker Image Version](https://img.shields.io/docker/v/idootop/open-xiaoai-migpt?color=%23086DCD&label=docker%20image)](https://hub.docker.com/r/idootop/open-xiaoai-migpt)

推荐使用以下命令，直接 Docker 一键运行。

```shell
docker run -it --rm -p 4399:4399 \
    --env-file $(pwd)/.env \
    -v $(pwd)/config.ts:/app/config.ts \
    idootop/open-xiaoai-migpt:latest
```

### 编译运行

> [!TIP]
> 如果你是一名开发者，想要修改源代码实现自己想要的功能，可以按照下面的步骤，自行编译运行该项目。

为了能够正常编译运行该项目，你需要安装以下依赖环境：

- Node.js v22.x: https://nodejs.org/zh-cn/download
- Rust: https://www.rust-lang.org/learn/get-started

准备好开发环境后，按以下步骤即可正常启动该项目。

```bash
# 启用 PNPM 包管理工具
corepack enable && corepack install

# 安装依赖
pnpm install

# 编译运行
pnpm dev
```

## 注意事项

1. 默认 Server 服务端口为 `4399`（比如 ws://192.168.31.227:4399），运行前请确保该端口未被其他程序占用。

2. 默认 Rust Server 在启动时，并没有开启小爱音箱的录音能力。
   如果你需要在 Node.js 端正常接收音频输入流，请将 `src/server.rs` 文件中被注释掉的 `start_recording` 代码加回来，然后重新编译运行。

3. 在 `.env` 里配齐 `TTS_BASE_URL`、`TTS_API_KEY`、`TTS_MODEL`、`TTS_VOICE` 四项后，会使用自定义的语音合成服务（输出 24kHz PCM16LE 单声道音频流）来播放文字。
   缺少其中任意一项，都会回退到小爱音箱自带的语音合成服务。
   该音频流由 `src/server.rs` 中 `start_play` 的音频参数决定，如需更换其他格式的语音合成服务，记得同步修改这两处配置。

> [!NOTE]
> 本项目只是一个简单的演示程序，抛砖引玉。如果你想要更多的功能，比如唤醒词识别、语音转文字、连续对话等（甚至是对接 OpenAI 的 [Realtime API](https://platform.openai.com/docs/guides/realtime)），可参考本项目代码自行实现。
