# xiaozhi vs migpt：语音助手方案对比

本文对比三种语音助手方案的核心区别，帮助选型。

| 方案 | 定位 |
|------|------|
| **xiaozhi** | 完全自建管线：自定义唤醒词 + VAD + MiMo ASR/TTS，**不依赖小爱云端** |
| **migpt** | 旁路劫持：借用小爱原生唤醒和云端 ASR，截获文本后替换回复 |
| **原生唤醒 + 自定义 ASR**（混合方案） | 取两者之长：借用小爱原生唤醒（高灵敏度），但自建录音 + VAD + ASR 管线，**不依赖小米云 ASR** |

---

## 二、核心对比

| 维度 | xiaozhi | migpt | 原生唤醒 + 自定义 ASR |
|------|---------|-------|----------------------|
| **唤醒方式** | 自定义唤醒词（sherpa-onnx KWS，如"你好小蜜"） | 小爱原生唤醒词（"小爱同学"，固件 DSP 两级检测） | 小爱原生唤醒词（"小爱同学"，固件 DSP 两级检测） |
| **唤醒灵敏度** | 较低（无波束成形、无 AEC、通用模型 token 匹配） | 高（专用 DNN 模型 + 8 麦克阵列 DSP + 声源测向） | 高（同 migpt，复用原生 DSP） |
| **ASR** | MiMo 云端 ASR（`mimo-v2.5-asr`），服务端直接处理 PCM | 小爱云端 ASR（小米服务器），通过 `instruction.log` 获取文本 | 自定义 ASR（如 MiMo），服务端录音后自行识别 |
| **VAD 端点检测** | silero-vad（服务端 ONNX 推理） | 小爱原生固件内置 VAD | silero-vad（服务端 ONNX 推理） |
| **TTS** | MiMo TTS（`mimo-v2.5-tts`） | MiMo TTS（可回退到小爱自带 TTS） | MiMo TTS（`mimo-v2.5-tts`） |
| **对话服务** | assistant 模块（`POST /chat` SSE） | assistant 模块（`POST /chat` SSE） | assistant 模块（`POST /chat` SSE） |
| **对小爱云端的依赖** | **无**（仅用音箱做音频 I/O） | **强依赖**（ASR 必须经小米云端） | **无**（仅借用原生唤醒，ASR 自建） |
| **是否需要联网（小米云）** | 不需要（MiMo 是独立服务） | 需要（小爱 ASR 走小米服务器） | 不需要（唤醒是本地 DSP，ASR 走自建服务） |
| **技术栈** | Python（uv） | Node.js / TypeScript（pnpm） | Python（基于 xiaozhi 改造） |
| **音频流方向** | 设备 → 服务端持续流式传输（arecord 常驻） | 设备端由固件处理，服务端只收文本 | 设备 → 服务端持续流式传输（arecord 常驻） |
| **录音链路** | 始终开启（GlobalStream 持续接收 PCM） | 默认关闭（`start_recording` 被注释） | 始终开启（同 xiaozhi） |

---

## 三、架构对比

### xiaozhi：全自建管线

```
麦克风 → arecord(持续) → WebSocket → GlobalStream
                                        │
                          ┌─────────────┼─────────────┐
                          ▼             ▼             ▼
                      KWS 唤醒词    VAD 端点检测   PCM 缓存
                    (sherpa-onnx)  (silero-vad)
                          │             │
                          └──────┬──────┘
                                 ▼
                          MiMo ASR → Agent → MiMo TTS → aplay → 扬声器
```

- 音频从设备**持续流式传输**到服务端
- 服务端同时运行 KWS（唤醒）和 VAD（端点检测）
- 唤醒后 VAD 截取语音段，送 MiMo ASR 转文字
- 小爱固件**仅作为音频 I/O 通道**，原生语音管线完全不参与

### migpt：旁路劫持

```
麦克风 → 小爱原生固件（唤醒 + 云端 ASR）
                │
                ▼
        instruction.log（识别文本）
                │
        Rust Client tail（10ms 轮询）
                │
                ▼ WebSocket
        MiGPT Engine（过滤 is_final）
                │
                ├─ abortXiaoAI()（杀掉原生回复）
                │
                ▼
        Agent → MiMo TTS → aplay → 扬声器
```

- 唤醒和 ASR **全部由小爱原生固件完成**
- 服务端通过 tail `instruction.log` 旁路获取识别文本
- 截获文本后 `abortXiaoAI()` 中止小爱原生回复，替换为自定义回复
- 服务端**不接触原始音频**（录音链路默认关闭）

### 原生唤醒 + 自定义 ASR：混合方案

```
┌──────────── 音箱端 ────────────┐     ┌────────────── 服务端 ──────────────┐
│                                 │     │                                    │
│  mipns-xiaomi（原生唤醒）       │     │  arecord 持续流式接收               │
│  DSP + 波束成形 + AEC           │     │       │                            │
│       │ 检测到"小爱同学"        │     │       ▼                            │
│       ▼                         │     │  环形缓冲区（保留最近 N 秒）        │
│  /var/log/messages              │     │       │                            │
│  "real wakeup"                  │     │  监听唤醒信号                      │
│       │                         │     │  (run_shell tail /var/log/messages)│
│       ▼                         │     │       │                            │
│  aivs_lab 启动（被立即中止）     │     │       ▼                            │
│                                 │     │  abortXiaoAI()                     │
│  arecord(持续) ──WebSocket──────────►  回溯缓冲区 + VAD 截取语音段         │
│  hw:0,3 PCM16 16kHz            │     │       │                            │
│                                 │     │       ▼                            │
│  aplay ◄──WebSocket─────────────────  自定义 ASR → Agent → MiMo TTS       │
└─────────────────────────────────┘     └────────────────────────────────────┘
```

- **唤醒由原生固件完成**（DSP 两级检测 + 波束成形 + AEC），灵敏度高
- 唤醒信号从 `/var/log/messages` 获取（mipns 写入，不经过 aivs_lab）
- 检测到唤醒后**立即中止 aivs_lab**，小米云 ASR 完全不参与
- 音频通过 arecord **持续流式传输**到服务端（同 xiaozhi）
- 服务端用**环形缓冲区**回溯唤醒前的音频，补偿检测延迟
- 后续 VAD 截取、ASR、Agent、TTS 流程**与 xiaozhi 完全一致**

---

## 四、唤醒机制详细对比

| 项目 | xiaozhi（自定义 KWS） | migpt（小爱原生） | 原生唤醒 + 自定义 ASR |
|------|----------------------|------------------|----------------------|
| 模型 | sherpa-onnx RNN-T（encoder/decoder/joiner，~20MB） | 专有 DNN（`wakeup_model.bin`，针对"小爱同学"训练） | 同 migpt（复用原生 `wakeup_model.bin`） |
| 检测层级 | 单级 transducer 解码 + 阈值（`keywords_threshold=0.2`） | 两级级联（`rice_wakeup 1-level / 2-level`） | 同 migpt（两级级联） |
| 波束成形 | 无（原始单通道 PDM） | 8 通道 → 1 通道 DSP 波束成形 | 同 migpt（8 通道 DSP） |
| 回声消除（AEC） | 无（靠暂停 KWS + 400ms debounce） | 有（xaudio_engine DSP 硬件级） | 同 migpt（DSP 硬件级，仅用于唤醒检测） |
| 噪声抑制 | 无 | DSP 内置 | 同 migpt（DSP 内置，仅用于唤醒检测） |
| 运行位置 | 服务端 CPU（单线程） | 设备端专用 DSP | 设备端专用 DSP |
| 唤醒词 | 可自定义（修改 `config.py` + 重新生成 `keywords.txt`） | 固定"小爱同学"（硬编码在模型中） | 固定"小爱同学"（硬编码在模型中） |
| 声源测向 | 无 | 有（返回角度，如 `angle:340`） | 有（同 migpt） |
| 唤醒信号获取 | 服务端 KWS 直接检测 | `instruction.log` 的 `is_final`（ASR 完成后） | `/var/log/messages` 的 `"real wakeup"`（ASR 之前） |

> **注意**：混合方案中，原生 DSP 的波束成形和 AEC **仅用于唤醒检测**。唤醒后录音走的是 arecord 原始 PDM 通道（`hw:0,3`），不经过 DSP 处理，因此后续 ASR 的音频质量与 xiaozhi 相同。

---

## 五、音频管线对比

| 项目 | xiaozhi | migpt | 原生唤醒 + 自定义 ASR |
|------|---------|-------|----------------------|
| 录音方式 | arecord 持续运行，PCM16 16kHz 流式传输 | 不录音（固件内部处理） | arecord 持续运行，PCM16 16kHz 流式传输 |
| 音频预处理 | 仅 int16→float32 归一化 | 固件 DSP（波束成形 + AEC + 降噪） | 仅 int16→float32 归一化（同 xiaozhi） |
| 服务端接收 | GlobalStream 持续接收，分发给 KWS/VAD/缓存 | 不接收音频，只接收文本事件 | GlobalStream 持续接收 + 环形缓冲区 |
| 播放方式 | MiMo TTS → PCM → WebSocket → aplay | MiMo TTS → PCM → WebSocket → aplay | MiMo TTS → PCM → WebSocket → aplay |
| 播放采样率 | 24kHz | 24kHz | 24kHz |
| TTS 回退 | 无（必须配置 MiMo） | 可回退到小爱自带 TTS（`tts_play.sh`） | 无（必须配置 MiMo） |

---

## 六、交互流程对比

### xiaozhi

```
1. KWS 检测到唤醒词 → pause KWS
2. 播放唤醒提示音 → sleep(0.8s) → 亮灯
3. VAD 检测语音起止 → 收集完整 PCM
4. MiMo ASR 转文字
5. Agent 对话（SSE 流式）
6. MiMo TTS 合成 → 播放
7. 播放"滴"提示音 → 进入多轮对话（VAD 等待下一句）
8. 超时 → 灭灯 → KWS.reset() → 恢复唤醒检测
```

### migpt

```
1. 用户说"小爱同学" → 原生固件唤醒（DSP 两级检测）
2. 原生固件录音 → 小米云端 ASR → 写入 instruction.log
3. Rust Client tail 日志 → 发现 is_final=true → WebSocket 上报
4. MiGPT Engine 过滤 → onMessage()
5. abortXiaoAI()（重启 mico_aivs_lab，杀掉原生回复）
6. Agent 对话（SSE 流式）
7. 流式分句 → MiMo TTS → 逐句播放
8. （可选）KEEP_AWAKE=true → ubus 触发多轮对话（7 秒窗口）
```

### 原生唤醒 + 自定义 ASR

```
1. 用户说"小爱同学" → 原生固件唤醒（DSP 两级检测）
2. mipns 写入 /var/log/messages "real wakeup"
3. 服务端 tail 检测到唤醒信号
4. 立即 abortXiaoAI()（中止 aivs_lab，小米云 ASR 未参与）
5. 播放自定义提示音 → 亮灯
6. 从环形缓冲区回溯唤醒前音频 + VAD 继续截取语音段
7. 自定义 ASR（MiMo）转文字
8. Agent 对话（SSE 流式）
9. MiMo TTS 合成 → 播放
10. 播放"滴"提示音 → 进入多轮对话（VAD 等待下一句）
11. 超时 → 灭灯 → 恢复唤醒监听
```

> **与 migpt 的关键区别**：migpt 等到 `is_final`（ASR 已完成）才介入，混合方案在 `"real wakeup"`（ASR 之前）就介入并中止原生流程。因此混合方案中小米云 ASR **完全没有执行**。

---

## 七、多轮对话对比

| 项目 | xiaozhi | migpt | 原生唤醒 + 自定义 ASR |
|------|---------|-------|----------------------|
| 实现方式 | VAD 持续监听，超时内检测到语音即继续 | ubus 触发原生多轮对话窗口 | VAD 持续监听（同 xiaozhi） |
| 窗口时长 | 可配置（`multiturn_timeout`，默认 8 秒） | 固件写死 7 秒 | 可配置（同 xiaozhi） |
| 是否需要补丁 | 不需要 | 需要补丁 04（`04-mipns-multirounds.sh`） | 不需要 |
| 提示音 | 设备端 `qplayer` 播放 `multirounds_tone.opus` | 原生固件自动播放 | 设备端 `qplayer` 播放（同 xiaozhi） |
| 超时处理 | 灭灯 → KWS.reset() → 恢复唤醒 | 固件自动退出多轮窗口 | 灭灯 → 恢复唤醒监听 |

---

## 八、设备端补丁需求

| 补丁 | xiaozhi | migpt | 原生唤醒 + 自定义 ASR |
|------|---------|-------|----------------------|
| 01/02 - asound（共享麦克风） | **必须** | **必须** | **必须** |
| 03 - libxaudio_engine（解除麦克风独占） | **必须** | **必须** | **必须** |
| 04 - mipns-multirounds（多轮对话） | 不需要 | 可选（`KEEP_AWAKE=true` 时需要） | 不需要 |

---

## 九、配置对比

### xiaozhi（`.env`）

```bash
MIMO_API_KEY=sk-xxx              # MiMo API 密钥（ASR + TTS 共用）
ASSISTANT_BASE_URL=http://...    # 对话服务地址
CLI=true                         # 启用 KWS + VAD
```

### migpt（`.env`）

```bash
AGENT_BASE_URL=http://...        # 对话服务地址
TTS_API_KEY=sk-xxx               # MiMo TTS 密钥
TTS_BASE_URL=https://...         # MiMo TTS 地址
TTS_MODEL=mimo-v2.5-tts
TTS_VOICE=mimo_default
KEEP_AWAKE=false                 # 多轮对话（需补丁 04）
AGENT_CALL_KEYWORDS=             # 关键词过滤（留空=全部转发）
```

### 原生唤醒 + 自定义 ASR（基于 xiaozhi `.env`）

```bash
MIMO_API_KEY=sk-xxx              # MiMo API 密钥（ASR + TTS 共用）
ASSISTANT_BASE_URL=http://...    # 对话服务地址
CLI=true                         # 启用 VAD（KWS 被原生唤醒替代）
```

---

## 十、优劣势总结

### xiaozhi

| 优势 | 劣势 |
|------|------|
| 不依赖小米云端，可离线唤醒 | 唤醒灵敏度低（无 DSP 前端处理） |
| 唤醒词可自定义 | 自定义唤醒词需要重新生成 token 文件 |
| ASR 可替换（实现 `transcribe()` 接口即可） | 需要持续传输音频流，带宽占用较高 |
| 多轮对话不需要固件补丁 | 无 AEC，TTS 播放后需等待回声消散 |
| 全链路可控，调试方便 | 通用 KWS 模型对特定唤醒词的建模能力弱于专用模型 |

### migpt

| 优势 | 劣势 |
|------|------|
| 唤醒灵敏度高（原生 DSP + 波束成形 + AEC） | 强依赖小米云端 ASR，断网即失效 |
| 不需要自己处理音频前端 | 无法自定义唤醒词 |
| 服务端不接触原始音频，带宽低 | 必须 `abortXiaoAI()`，有 1-2 秒恢复期 |
| TTS 可回退到小爱自带 | `abortXiaoAI()` 会卡住 mipns 状态机（需补丁 04 修复） |
| 原生 VAD，端点检测准确 | ASR 结果无标点，且不可控 |
| | 多轮对话需要固件补丁 |

### 原生唤醒 + 自定义 ASR

| 优势 | 劣势 |
|------|------|
| 唤醒灵敏度高（复用原生 DSP + 波束成形 + AEC） | 唤醒词固定为"小爱同学"，不可自定义 |
| 不依赖小米云 ASR，ASR 服务可替换 | 需要持续传输音频流，带宽占用较高 |
| ASR 结果可控（有标点、可选模型） | 录音无 DSP 处理（arecord 原始 PDM），ASR 音频质量同 xiaozhi |
| 多轮对话不需要固件补丁 | 需要额外实现 `/var/log/messages` 监听和环形缓冲区 |
| 全链路可控（唤醒后的 VAD/ASR/TTS 均自建） | 需要 `abortXiaoAI()` 中止原生流程 |
| 断网（小米云）不影响唤醒和 ASR | 方案尚未有现成实现，需基于 xiaozhi 改造 |

---

## 十一、选型建议

| 场景 | 推荐方案 |
|------|---------|
| 需要高灵敏度唤醒、不在意依赖小米云 | **migpt** |
| 需要完全脱离小米云、可接受唤醒灵敏度妥协 | **xiaozhi** |
| 需要自定义唤醒词 | **xiaozhi** |
| 需要可替换的 ASR 服务 | **xiaozhi** 或 **原生唤醒 + 自定义 ASR** |
| 不想打太多固件补丁 | **xiaozhi**（不需要补丁 04） |
| 网络不稳定或需要离线能力 | **xiaozhi**（唤醒和 VAD 在本地） |
| 既要高灵敏度唤醒、又要自定义 ASR | **原生唤醒 + 自定义 ASR** |
| 不想依赖小米云但唤醒灵敏度是刚需 | **原生唤醒 + 自定义 ASR** |

---

## 十二、原生唤醒 + 自定义 ASR 方案详解

本节详细描述混合方案的实现要点。该方案基于 xiaozhi 改造，将唤醒检测从 sherpa-onnx KWS 替换为小爱原生唤醒，其余管线（VAD、ASR、Agent、TTS）保持不变。

### 12.1 核心思路

```
xiaozhi 原方案：  arecord 持续流 → sherpa-onnx KWS 检测唤醒 → VAD → ASR → Agent → TTS
混合方案：        arecord 持续流 → 原生唤醒信号触发 → VAD → ASR → Agent → TTS
                                 ↑
                    /var/log/messages "real wakeup"
```

只替换唤醒触发源，其余全部复用 xiaozhi 的 `GlobalStream`、`silero-vad`、`MiMo ASR`、`AgentConnector`、`MiMo TTS` 等模块。

### 12.2 唤醒信号检测

原生唤醒事件**不在 `instruction.log` 中**（那是 aivs_lab 写的，属于 ASR 阶段）。唤醒由 mipns-xiaomi 内部完成，写入系统日志：

```
# /var/log/messages 中的唤醒记录
Jul 22 10:30:15 user.info mipns-xiaomi: xaudio_engine: real wakeup--
Jul 22 10:30:15 user.info mipns-xiaomi: [mipns::main]:[W]mipns_speech.event=wakeup-1! angle:340
```

检测方式：通过 Rust Client 的 `run_shell` RPC 在设备上执行 `tail -f /var/log/messages`，持续监听 `"real wakeup"` 关键字。

```python
# 伪代码：唤醒信号监听
async def watch_native_wakeup(speaker):
    proc = await speaker.run_shell_stream("tail -f /var/log/messages")
    async for line in proc:
        if "real wakeup" in line:
            await on_native_wakeup()
```

**为什么不用 `instruction.log` 的 `is_vad_begin`？**

| 信号 | 时机 | 问题 |
|------|------|------|
| `/var/log/messages` `"real wakeup"` | 唤醒瞬间（ASR 之前） | 需要额外 tail 进程 |
| `instruction.log` `is_vad_begin=true` | 用户开始说话后（ASR 已启动） | aivs_lab 已在运行，小米云 ASR 已介入，与 migpt 无本质区别 |
| `instruction.log` `is_final=true` | ASR 完成后 | 完全等同于 migpt |

要实现"原生唤醒 + 自定义 ASR"，必须用 `"real wakeup"` 信号，在 aivs_lab 启动 ASR 之前就介入。

### 12.3 中止原生流程

检测到唤醒后**立即**中止 aivs_lab，防止小米云 ASR 执行：

```python
async def on_native_wakeup():
    # 1. 立即中止原生流程（aivs_lab 还没来得及完成 ASR）
    await speaker.run_shell("/etc/init.d/mico_aivs_lab restart >/dev/null 2>&1")

    # 2. 播放自定义提示音 + 亮灯（替代原生 wakeup.sh）
    await speaker.run_shell("qplayer /usr/share/common_sound/wakeup_prompt.opus")
    await speaker.run_shell("show_led 1")

    # 3. 从环形缓冲区回溯 + VAD 截取语音段
    pcm = await vad_capture_with_lookback()

    # 4. 后续流程与 xiaozhi 完全一致
    text = await mimo_asr.transcribe(pcm)
    response = await agent.chat(text)
    await mimo_tts.speak(response)
```

> **与 migpt 的 `abortXiaoAI()` 区别**：migpt 在 ASR 完成后（`is_final`）才中止，此时小米云 ASR 已经执行完毕；混合方案在唤醒瞬间（`"real wakeup"`）就中止，小米云 ASR **完全没有执行**。

### 12.4 环形缓冲区

`"real wakeup"` 信号从设备传到服务端有延迟（tail 轮询 + WebSocket 传输，约 50-200ms）。用户可能在唤醒后立即开始说话，因此需要**回溯唤醒前的音频**：

```python
class RingBuffer:
    """保留最近 N 秒的 PCM 音频"""

    def __init__(self, duration_sec=2, sample_rate=16000, sample_width=2):
        self.max_bytes = duration_sec * sample_rate * sample_width
        self.buffer = bytearray()

    def write(self, data: bytes):
        self.buffer.extend(data)
        if len(self.buffer) > self.max_bytes:
            self.buffer = self.buffer[-self.max_bytes:]

    def read_all(self) -> bytes:
        """唤醒后调用：取回缓冲区中所有音频"""
        return bytes(self.buffer)
```

工作流程：

```
arecord 持续流 → GlobalStream → 环形缓冲区（始终写入，保留最近 2 秒）
                                      │
                    检测到 "real wakeup" │
                                      ▼
                    回溯缓冲区（取回唤醒前的音频）
                    + 继续收集（VAD 检测语音起止）
                    = 完整语音段
```

### 12.5 与 xiaozhi 的代码改动点

| 模块 | xiaozhi 原实现 | 混合方案改动 |
|------|---------------|-------------|
| 唤醒检测 | `kws/sherpa.py`（sherpa-onnx KWS） | **替换为** `/var/log/messages` tail 监听 |
| 唤醒回调 | `EventManager.wakeup()` 由 KWS 触发 | 由原生唤醒信号触发，逻辑不变 |
| 音频流 | `GlobalStream` 持续接收 | **不变** |
| 环形缓冲区 | 无（KWS 实时检测，无需回溯） | **新增**，保留最近 2 秒 PCM |
| VAD | `silero-vad` 截取语音段 | **不变**，增加从缓冲区回溯的逻辑 |
| ASR | MiMo ASR | **不变** |
| Agent | AgentConnector | **不变** |
| TTS | MiMo TTS | **不变** |
| 中止原生回复 | 无（不经过原生流程） | **新增** `abortXiaoAI()` |
| KWS 模型文件 | 需要下载（~20MB） | **不需要**（不再使用 sherpa-onnx KWS） |

### 12.6 注意事项

1. **录音无 DSP 处理**：arecord 读取的是原始 PDM 数据（`hw:0,3`），不经过 mipns 的波束成形和 AEC。原生 DSP 处理**仅用于唤醒检测阶段**，唤醒后的录音质量与 xiaozhi 相同。
2. **TTS 回声问题**：与 xiaozhi 相同，TTS 播放期间录音会有回声。需要在 TTS 结束后等待 debounce（400ms）再开始 VAD 检测。
3. **`abortXiaoAI()` 的副作用**：重启 `mico_aivs_lab` 会将 mipns 状态机卡在 `transmitend`。但由于混合方案的多轮对话走 VAD（不走原生多轮窗口），且唤醒词检测可从任意状态触发（`local pre-wakeup`），因此**不需要补丁 04**。
4. **`/var/log/messages` 的可靠性**：该文件由 syslog-ng 写入，在 LX06 固件上稳定可用。注意 `logread`/`syslogd` 在该固件上不存在。
5. **tail 进程管理**：`tail -f /var/log/messages` 作为长驻进程运行在设备上，需要处理进程意外退出的重连逻辑。

---

## 十三、关键代码索引

| 模块 | xiaozhi | migpt | 原生唤醒 + 自定义 ASR |
|------|---------|-------|----------------------|
| 唤醒检测 | `examples/xiaozhi/xiaozhi/services/audio/kws/sherpa.py` | 小爱原生固件（`mipns-xiaomi`） | 小爱原生固件 + `/var/log/messages` tail |
| VAD | `examples/xiaozhi/xiaozhi/services/audio/vad/silero.py` | 小爱原生固件 | `examples/xiaozhi/xiaozhi/services/audio/vad/silero.py` |
| ASR | `examples/xiaozhi/xiaozhi/services/asr/` | 小爱云端（`instruction.log`） | `examples/xiaozhi/xiaozhi/services/asr/` |
| 事件管理 | `examples/xiaozhi/xiaozhi/event.py` | `examples/migpt/src/xiaoai.ts` | `examples/xiaozhi/xiaozhi/event.py`（改造唤醒触发源） |
| 对话代理 | `examples/xiaozhi/xiaozhi/services/agent.py` | `examples/migpt/src/agent.ts` | `examples/xiaozhi/xiaozhi/services/agent.py` |
| TTS | `examples/xiaozhi/xiaozhi/services/tts/` | `examples/migpt/src/tts.ts` | `examples/xiaozhi/xiaozhi/services/tts/` |
| 音频流 | `examples/xiaozhi/xiaozhi/services/audio/stream.py` | 不涉及（固件内部） | `examples/xiaozhi/xiaozhi/services/audio/stream.py` + 环形缓冲区 |
| 设备控制 | `examples/xiaozhi/xiaozhi/services/speaker.py` | `examples/migpt/src/speaker.ts` | `examples/xiaozhi/xiaozhi/services/speaker.py` |
| 中止原生回复 | 不涉及 | `examples/migpt/src/speaker.ts`（`abortXiaoAI()`） | 需新增（同 migpt 的 `abortXiaoAI()`） |
| 配置 | `examples/xiaozhi/config.py` + `.env` | `examples/migpt/src/config.ts` + `.env` | `examples/xiaozhi/config.py` + `.env` |
| 日志监听 | 不涉及 | `packages/client-rust/src/services/monitor/instruction.rs` | 需新增 `/var/log/messages` tail |
