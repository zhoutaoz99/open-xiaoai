# Open-XiaoAI x MiMo — 本地唤醒 + 云端 ASR

基于 [Open-XiaoAI](https://github.com/idootop/open-xiaoai)，通过自定义唤醒词 + VAD 端点检测 + 小米 MiMo ASR/TTS，实现完全独立于小爱云端的语音助手。大模型对话能力通过对接 [assistant](../assistant) 模块实现。

### 与小爱原生的关系

本方案**完全不依赖小爱云端**——唤醒、ASR、TTS 全部走自建管线，原生小爱固件仅作为音频 I/O 通道（麦克风和扬声器）。


## 架构

```
小爱音箱
  │ 麦克风
  ▼
open-xiaoai Rust client ── PCM16 16kHz ──→ GlobalStream
  │                                           │
  │                              ┌────────────┼────────────┐
  │                              ▼            ▼            ▼
  │                          KWS 唤醒词    VAD 端点检测   AudioCodec
  │                        (sherpa-onnx)  (silero-vad)    (PCM 缓存)
  │                              │            │            │
  │                         检测到唤醒词   检测开始/结束   收集全部 PCM
  │                              │            │            │
  │                              └────────────┘            │
  │                                     ▼                  ▼
  │                              EventManager.wakeup()   PCM bytes
  │                                     │
  │                                     ▼
  │                              MiMo ASR (语音转文字)
  │                         POST /v1/chat/completions
  │                              model: mimo-v2.5-asr
  │                                     │
  │                                     ▼ text
  │                          AgentConnector (对话代理)
  │                         POST /chat ──→ assistant 模块
  │                         SSE stream ←── (大模型 agent)
  │                                     │
  │                                     ▼ text
  │                              MiMo TTS (文字转语音)
  │                         POST /v1/chat/completions
  │                         model: mimo-v2.5-tts, stream: true
  │                                     │
  │                                     ▼ PCM16 bytes
  │                              GlobalStream.output()
  │                                     │
  │                                     ▼ TTS 播完
  │                              播放"滴"提示音 (multirounds_tone.wav)
  │                                     │
  │                                     ▼
  │                              continue_listening (等待下一轮语音)
  │                                     │
  │ 扬声器 ◄────────────────────────────┘
  │ aplay
```

### 交互生命周期

```
唤醒词 ("你好小蜜")
  → KWS 检测 → pause KWS
  → before_wakeup: 放唤醒提示音 → sleep(0.8s) → show_led 1 (亮灯)
  → resume KWS, state=IDLE
  → VAD 收音 → 采集 PCM → on_wakeup
  → _handle_wakeup: state=LISTENING → pipeline.run()
      → ASR → Agent → TTS (state=SPEAKING)
  → TTS 播完:
      ① 播放"滴"提示音 (multirounds_tone.wav, ~0.92s)
      ② continue_listening → VAD 等待下一轮语音 (多轮对话)
  → 多轮超时或无语音:
      ① shut_led 1 (灭灯)
      ② state=IDLE (恢复 KWS)
      ③ KWS.reset() (清空音频缓冲)
```

### 职责边界

| 模块 | 职责 |
|------|------|
| **xiaozhi（本模块）** | 唤醒词检测、VAD 端点检测、语音转文字（MiMo ASR）、文字转语音（MiMo TTS）、对接 assistant |
| **assistant** | 大模型对话、多轮上下文维护、提醒推送、工具调用 |
| **open-xiaoai Rust client** | 音箱端音频采集/播放、WebSocket 通信 |


## 快速开始

> 继续下面的操作之前，需要先在音箱上运行 Rust 补丁程序 [→ 教程](../../packages/client-rust/README.md)。

### 1. 环境准备

- [uv](https://github.com/astral-sh/uv)
- [Rust](https://www.rust-lang.org/learn/get-started)
- [Opus](https://opus-codec.org/) 动态库
- macOS: `brew install portaudio`；Linux: `apt install portaudio19-dev libopus-dev`

### 2. 安装与配置

```bash
cd examples/xiaozhi

# 安装依赖
uv sync

# 下载 VAD + KWS 模型文件到 xiaozhi/models/
curl -sSfL -o models.zip \
  "https://github.com/idootop/open-xiaoai/releases/download/vad-kws-models/models.zip"
unzip -o models.zip -d xiaozhi/models/
rm models.zip

# 编译 Rust 原生模块 (open_xiaoai_server)
uv run maturin develop

# 创建 .env 配置文件
cp .env.example .env
```

编辑 `.env`：

```bash
# MiMo API 密钥（必填）
MIMO_API_KEY=sk-xxxxxxxxxxxxxxxx

# 对话服务地址（必填，指向 assistant 模块）
ASSISTANT_BASE_URL=http://127.0.0.1:8000
```

### 3. 启动

```bash
# 终端 1：启动 assistant（大模型对话服务）
cd examples/assistant
docker compose up

# 终端 2：启动 xiaozhi
cd examples/xiaozhi
uv run python main.py
```

首次启动会加载模型文件，约需 30 秒。看到 banner 和 `✅ 已启动: "0.0.0.0:4399"` 即就绪。


## 配置参考

所有配置通过 `.env` 文件管理。完整可选项：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MIMO_API_KEY` | （必填） | MiMo API 密钥 |
| `CLI` | `true` | 必设为 `true`，启用 KWS + VAD |
| **ASR** | | |
| `ASR_BASE_URL` | `https://api.xiaomimimo.com/v1` | ASR 接口地址 |
| `ASR_LANGUAGE` | `zh` | 识别语言（`zh`=中文，`auto`=自动） |
| **TTS** | | |
| `TTS_BASE_URL` | `https://api.xiaomimimo.com/v1` | TTS 接口地址 |
| `TTS_MODEL` | `mimo-v2.5-tts` | TTS 模型 |
| `TTS_VOICE` | `mimo_default` | TTS 音色 |
| **Assistant（对话代理）** | | |
| `ASSISTANT_BASE_URL` | `http://127.0.0.1:8000` | assistant 模块地址 |
| `ASSISTANT_SESSION_ID` | `default` | 会话 ID，同一会话共享多轮上下文 |
| `ASSISTANT_API_KEY` | （可选） | 鉴权密钥 |
| `ASSISTANT_STREAM` | `true` | 是否使用 SSE 流式响应 |
| `ASSISTANT_TIMEOUT` | `30` | 首事件超时（秒） |

## 自定义唤醒词与提示音

编辑 `config.py`：

```python
APP_CONFIG = {
    "wakeup": {
        "keywords": [
            "你好小蜜",
        ],
        "timeout": 8,                # 唤醒后等待说话的超时（秒）
        "multiturn_timeout": 8,      # 多轮对话等待下一句的超时（秒）
        "before_wakeup": before_wakeup,  # 唤醒后的提示音 + 亮灯回调
        "after_wakeup": after_wakeup,    # 超时或无语音时的灭灯回调
    },
    "beep": {
        "enabled": True,
        "sound": "/usr/share/common_sound/multirounds_tone.opus",  # 设备上的原生"滴"提示音
    },
    "vad": {
        "threshold": 0.30,             # 语音检测阈值（0-1，越小越灵敏）
        "min_speech_duration": 500,    # 最小语音时长（ms）
        "min_silence_duration": 700,   # 最小静默时长（ms，调大可减少抢话）
        "debounce_duration": 400,      # VAD 启动后忽略的帧数（ms），等 TTS 余音消散
    },
}
```

修改唤醒词后需要重新生成编码文件：

```bash
uv run python xiaozhi/services/audio/kws/keywords.py
```

### 提示音

TTS 播完后的"滴"提示音直接通过 `qplayer` 在设备端播放设备上的原生文件（`/usr/share/common_sound/multirounds_tone.opus`），无需下载到本地。这与原生 `wakeup.sh multirounds` 使用同一文件和播放器。

如果设备端播放失败（如 CLI 模式无设备连接），会 fallback 到本地生成正弦波提示音通过 `GlobalStream.output()` 播放。


## 对话服务接口

xiaozhi 通过 `AgentConnector` 与 assistant 模块通信，协议参见 [PROTOCOL.md](../assistant/PROTOCOL.md)。

简要来说，xiaozhi 发送：

```http
POST /chat
Content-Type: application/json

{
  "request_id": "uuid",
  "session_id": "default",
  "text": "今天天气怎么样",
  "stream": true
}
```

assistant 通过 SSE 流式返回：

```
event: delta
data: {"text":"今天"}

event: delta
data: {"text":"天气晴朗。"}

event: done
data: {}
```

xiaozhi 收到完整回复后通过 MiMo TTS 合成并播放。


## Docker 运行

```bash
docker build -t open-xiaoai-xiaozhi .
docker run -it --rm \
  -p 4399:4399 \
  --env-file .env \
  open-xiaoai-xiaozhi
```


## 常见问题

### Q：唤醒词识别不灵敏

调低 `config.py` 中的 `vad.threshold`（如 `0.05`）；或更换更容易识别的唤醒词（如"天猫精灵"）。

### Q：话没说完 AI 就抢答

调大 `config.py` 中的 `min_silence_duration`（如 `800`）。

### Q：语音识别不准

`ASR_LANGUAGE` 确认已设为 `zh`。MiMo-V2.5-ASR 对标准普通话效果较好，方言和口音支持有限。

### Q：assistant 没启动时报错

检查 `ASSISTANT_BASE_URL` 是否正确，且 assistant 模块已启动。

### Q：改了模型文件或唤醒词需要重新下载吗

不需要，模型文件只需下载一次。修改唤醒词后重新运行 `keywords.py` 即可。

### Q：如何更换其他 ASR 服务

实现一个与 `MiMoASR` 相同接口的类即可——只需实现 `async def transcribe(self, pcm_data: bytes) -> str` 方法。其他 TTS、Agent 同理。

### Q：TTS 播完后没有"滴"提示音

检查 `config.py` 中 `beep.enabled` 是否为 `True`。提示音通过 `qplayer` 在设备端播放，确认设备已连接且 `/usr/share/common_sound/multirounds_tone.opus` 文件存在。设备不可用时会 fallback 到正弦波提示音。
