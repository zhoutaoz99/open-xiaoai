# Open-XiaoAI x MiGPT-Next

[Open-XiaoAI](https://github.com/idootop/open-xiaoai) 的 Node.js 版 Server 端，用来演示小爱音箱接入[MiGPT](https://github.com/idootop/mi-gpt)（完美版）。

相比原版的 `MiGPT` 和 `MiGPT-Next` 项目，该版本可以完美打断小爱音箱的回复，响应延迟更低，效果更完美 👍

> [!TIP]
> 想了解从唤醒到语音输出的完整链路（含架构图和时序图），请查看 [👉 端到端链路详解](./ARCHITECTURE.md)

> [!IMPORTANT]
> 本项目**不再自己调用大模型**，只负责唤醒、语音识别和语音播报。
> 识别到的文字会转发给一个**外部对话服务**，再把它返回的文字播报出来。
>
> - 接口协议：[👉 PROTOCOL.md](../assistant/PROTOCOL.md)
> - 开箱即用的外部服务：[👉 examples/assistant](../assistant)（纯内存多轮对话，原来的 `OPENAI_*` 配置搬过去就能用）

## 快速开始

> [!NOTE]
> 继续下面的操作之前，你需要：
>
> 1. 在小爱音箱上启动运行 Rust 补丁程序 [👉 教程](../../packages/client-rust/README.md)
> 2. 准备好一个外部对话服务，可以直接用 [examples/assistant](../assistant)

首先，克隆仓库代码到本地。

```shell
# 克隆代码
git clone https://github.com/idootop/open-xiaoai.git

# 进入当前项目根目录
cd examples/migpt
```

然后修改 `.env.example` 文件里的配置，并重命名为 `.env`。

```bash
# 外部对话服务配置，对应 config.ts 里的 agent 配置
# 接口协议详见 examples/assistant/PROTOCOL.md，参考实现见 examples/assistant

#你的外部对话服务的接口地址（不包含 /chat 部分）
#注意：删除该配置后，所有消息都会交回小爱原生处理
AGENT_BASE_URL=http://127.0.0.1:8000

#API 密钥（删除该配置则不发送 Authorization 请求头）
AGENT_API_KEY=

#会话标识，外部服务据此维护多轮上下文
AGENT_SESSION_ID=default

#只转发以下关键词开头的消息，其余交回小爱原生处理（英文逗号分隔）
#删除该配置或留空表示全部转发
AGENT_CALL_KEYWORDS=


# 对话行为配置，对应 config.ts 里的 keepAwake 配置

#回复播完后自动唤醒小爱，方便直接追问，不用再说一遍唤醒词
#删除该配置或设为 false 表示不保持唤醒（默认）
KEEP_AWAKE=false


# 提醒推送服务配置，对应 config.ts 里的 push 配置
# 外部服务可以 POST /push 主动让音箱说话，比如定时提醒

#推送服务监听的端口（删除该配置则不启动推送服务）
AGENT_PUSH_PORT=4400

#推送密钥（删除该配置则不校验，同网络下任何人都能让音箱说话）
AGENT_PUSH_API_KEY=


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

> [!NOTE]
> 完整的配置项见 `.env.example`。系统提示词、模型、多轮对话记忆这些**都在外部服务那边配**，migpt 不再关心。

自定义回复等逻辑，在 `config.ts` 的 `onMessage` 钩子里修改成你自己的。

```typescript
async onMessage(engine, msg) {
  // 本地快捷指令：不走外部服务，直接回复
  if (msg.text === "测试") {
    // 记得先打断小爱，否则它会用自己的答案跟你抢着说话
    await engine.speaker.abortXiaoAI();
    return { text: "你好，很高兴认识你！" };
  }

  // 其余消息转发给外部对话服务（默认逻辑）
  // ...
}
```

### Docker 运行

[![Docker Image Version](https://img.shields.io/docker/v/idootop/open-xiaoai-migpt?color=%23086DCD&label=docker%20image)](https://hub.docker.com/r/idootop/open-xiaoai-migpt)

推荐使用以下命令，直接 Docker 一键运行。

```shell
docker run -it --rm -p 4399:4399 -p 4400:4400 \
    --env-file $(pwd)/.env \
    -v $(pwd)/config.ts:/app/config.ts \
    idootop/open-xiaoai-migpt:latest
```

> [!TIP]
> `4400` 是提醒推送服务的端口（`AGENT_PUSH_PORT`），不需要外部服务主动推送提醒的话可以不映射。
> 另外容器里访问宿主机上的外部对话服务，`AGENT_BASE_URL` 要写 `http://host.docker.internal:8000` 而不是 `127.0.0.1`。

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
   配了 `AGENT_PUSH_PORT` 时还会额外占用一个端口（默认 `4400`）用于接收外部服务推送的提醒。

2. 默认 Rust Server 在启动时，并没有开启小爱音箱的录音能力。
   如果你需要在 Node.js 端正常接收音频输入流，请将 `src/server.rs` 文件中被注释掉的 `start_recording` 代码加回来，然后重新编译运行。

3. 在 `.env` 里配齐 `TTS_BASE_URL`、`TTS_API_KEY`、`TTS_MODEL`、`TTS_VOICE` 四项后，会使用自定义的语音合成服务（输出 24kHz PCM16LE 单声道音频流）来播放文字。
   缺少其中任意一项，都会回退到小爱音箱自带的语音合成服务。
   该音频流由 `src/server.rs` 中 `start_play` 的音频参数决定，如需更换其他格式的语音合成服务，记得同步修改这两处配置。

4. 配置 `KEEP_AWAKE=true` 后可以连续对话：回复播完音箱会自己放提示音、点灯，并保持约 7 秒的收音窗口（时长由固件决定），接着说就行，不用再说一遍唤醒词。窗口内没人说话会自动退出，不会一直收音。
   **该功能需要刷入开启了多轮对话的补丁固件**（[👉 client-patch](../../packages/client-patch/README.md)）。原版固件下这个开关不会报错，但也不会有任何效果。
   注意只有外部服务的回复（以及你在 `onMessage` 里自己返回的回复）才会进入连续对话，交回小爱原生处理的消息和外部服务推送的提醒都不会。

   连续对话期间，外部服务可以在响应里带上 `keep_awake: false` 主动退出（比如用户说「关闭」），migpt 把这句话播完就不再开收音窗口，详见 [PROTOCOL.md](../assistant/PROTOCOL.md) 的 5.4 节。

> [!NOTE]
> 本项目只是一个简单的演示程序，抛砖引玉。如果你想要更多的功能，比如唤醒词识别、语音转文字等（甚至是对接 OpenAI 的 [Realtime API](https://platform.openai.com/docs/guides/realtime)），可参考本项目代码自行实现。
