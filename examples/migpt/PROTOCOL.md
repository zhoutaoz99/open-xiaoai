# Open-XiaoAI × 外部对话服务 接口协议 v1

本协议定义 `examples/migpt` 与**外部对话服务**之间的接口，包含两条独立的通道：

| 通道 | 方向 | 端点 | 用途 |
| --- | --- | --- | --- |
| **对话** | migpt → 外部服务 | `POST {AGENT_BASE_URL}/chat` | 把识别到的文字交给外部服务，取回回复 |
| **推送** | 外部服务 → migpt | `POST {migpt}:{AGENT_PUSH_PORT}/push` | 外部服务主动让音箱说话，比如定时提醒 |

## 一、角色与边界

```
小爱固件            migpt                          外部服务
─────────           ────────────────────           ────────────
唤醒 + ASR   ──▶   拿到识别文字
                   打断小爱
                   POST /chat    ─────────────▶    收文本
                                                   （自己维护上下文）
                   TTS 播报      ◀─────────────    出文本
                   ─▶ 🔊

                   POST /push    ◀─────────────    主动推送提醒
                   TTS 播报
                   ─▶ 🔊
```

| 职责 | 归属 |
| --- | --- |
| 唤醒词识别、语音识别（ASR） | 小爱原生固件（本协议不涉及） |
| 获取识别文字、打断小爱、TTS 合成与播放、抢话打断、播报排队 | migpt |
| **接收文本 → 返回文本**、多轮上下文维护、决定何时推送提醒 | **外部服务** |

外部服务不需要关心音频、TTS、设备控制、打断时序，只做纯文本的进出。

## 二、为什么两条通道都用 HTTP

对话通道是天然的请求-响应，用 WebSocket 反而要自己做请求-响应配对；推送通道是低频的单向消息。为了低频推送把整个协议改成 WebSocket，要额外背上重连、心跳、消息配对三份复杂度，不划算。

代价是**推送通道要求 migpt 的端口对外部服务可达**（同机或同内网）。如果外部服务在公网、migpt 在 NAT 后面，这个方向建不起来，得改成 migpt 主动订阅外部服务的 SSE 长连接。

对话通道的流式响应用 SSE：几行就能实现，`curl -N` 能直接调试，取消语义天然映射到断开连接。

---

# 对话通道（migpt → 外部服务）

## 三、传输层

| 项目 | 约定 |
| --- | --- |
| 协议 | HTTP/1.1 |
| 端点 | `POST {AGENT_BASE_URL}/chat` |
| 请求 | `Content-Type: application/json` |
| 响应 | 非流式 `application/json`；流式 `text/event-stream`（SSE） |
| 鉴权 | 可选，`Authorization: Bearer {AGENT_API_KEY}` |

## 四、请求

```jsonc
POST /chat
Content-Type: application/json

{
  "request_id": "9f1c8e2a-...",   // 必填。UUID，对应 migpt 的 msg.id，用于日志追踪
  "session_id": "default",        // 必填。会话标识，外部服务据此维护上下文
  "text": "你好你是谁",            // 必填。ASR 识别结果
  "stream": true,                 // 可选。默认 false
  "timestamp": 1721030400000      // 可选。消息产生时间（毫秒）
}
```

关于 `text` 字段，有三点要注意：

1. 它是小爱云端 ASR 的**最终结果**（`is_final === true`），不含唤醒词「小爱同学」。
2. **不保证有标点**。ASR 结果常常是「你好你是谁」这样没有标点的。
3. 可能包含识别错误，外部服务需要有一定容错。

## 五、响应

### 5.1 非流式（`stream: false`）

`200 OK` + `application/json`：

```jsonc
{
  "text": "我是你的智能助手。",   // 要播报的文字。空字符串或省略 = 不播报
  "url": null,                   // 可选。播放音频链接（与 text 互斥，url 优先）
  "fallback": false              // 可选。true = 放弃本次回答，交回小爱原生回答
}
```

### 5.2 流式（`stream: true`）

`200 OK` + `text/event-stream`：

```
event: delta
data: {"text":"我是"}

event: delta
data: {"text":"你的智能助手。"}

event: done
data: {}

```

事件类型：

| event | data | 说明 |
| --- | --- | --- |
| `delta` | `{"text":"..."}` | 文本增量，可发送多次 |
| `done` | `{}` | 正常结束。**必须发送**，migpt 据此结束播报 |
| `error` | `{"message":"...","text":"..."}` | 出错。`text` 为可选的兜底播报话术 |
| `fallback` | `{}` | 放弃本次回答，交回小爱。**必须在任何 `delta` 之前发送** |

### 5.3 对回复文本的要求（重要）

migpt 侧用 `@mi-gpt/stream` 做分句播报，参数如下（`@mi-gpt/stream/dist/chunk-5ZUHPAQL.js`）：

| 参数 | 默认值 |
| --- | --- |
| `sentenceEndings` | `。？！；?!;` |
| `maxReplyLength` | 200 |
| `firstReplyTimeout` | 500ms |

由此产生两条硬约束：

1. **回复文本必须带正常标点**。分句器只在 `。？！；?!;` 处切句；一段没有标点的长文本在流结束前**一个字都不会播报**，只能等 `done` 之后按 200 字硬切。这会让流式失去意义。
2. **不必自己切句**。`delta` 想多碎就多碎（逐 token 也行），migpt 会自己攒句子。

另外两点可以放心：

- **emoji 会被 migpt 自动剔除**（`removeEmojis`），服务端不用处理。
- **单句超过 200 字会被硬切**，建议控制单句长度，避免在奇怪的地方断开。

## 六、取消（抢话打断）

用户在播报途中说新的话时，migpt 会**直接断开本次 HTTP 连接**，不发送任何取消信令。

服务端应监听客户端断连并立即停止生成：

- FastAPI：`await request.is_disconnected()`
- Express：`req.on("close", ...)`

不提供独立的 `/cancel` 端点——**连接即生命周期**。

## 七、错误与超时

| 阶段 | 超时 | migpt 行为 |
| --- | --- | --- |
| 首个事件 / 完整响应 | `AGENT_TIMEOUT_MS`，默认 10s | 播报兜底话术 |
| 流式响应中断 | 60s | 断开连接，把已收到的内容播完 |

非 200 响应、连接失败、超时，migpt 统一播报 `AGENT_ERROR_TEXT`（默认「出错了，请稍后再试吧」）。外部服务的业务错误建议走 `event: error` 并带上友好的 `text`，比 HTTP 500 的播报效果好。

## 八、会话与上下文

- `session_id` 由 migpt 侧配置（`AGENT_SESSION_ID`，默认 `default`），进程生命周期内固定。
- migpt 服务端同一时刻只处理一个音箱连接（`src/server.rs`），所以单实例场景下固定值即可。
- **多轮上下文完全由外部服务维护** —— migpt 内置的 `ChatBot` 历史已被绕过，migpt 侧不再保留任何对话记忆。
- 外部服务需自行处理上下文窗口大小与会话超时淘汰。

## 九、健康检查

```
GET {AGENT_BASE_URL}/health  →  200 {"status":"ok"}
```

migpt 启动时探测一次，失败仅打印告警，不阻塞启动。

---

# 推送通道（外部服务 → migpt）

## 十、接口

| 项目 | 约定 |
| --- | --- |
| 协议 | HTTP/1.1 |
| 端点 | `POST http://{migpt}:{AGENT_PUSH_PORT}/push` |
| 鉴权 | 可选，`Authorization: Bearer {AGENT_PUSH_API_KEY}` |
| 健康检查 | `GET /health` → `200 {"status":"ok"}` |

请求：

```jsonc
{
  "text": "该吃药了。",   // 要播报的文字
  "url": null            // 可选。播放音频链接（与 text 互斥，url 优先）
}
```

响应：

| 状态码 | body | 说明 |
| --- | --- | --- |
| 202 | `{"ok":true}` | 已接受并排队 |
| 400 | `{"ok":false,"error":"text or url is required"}` | 参数缺失 |
| 400 | `{"ok":false,"error":"invalid json"}` | 请求体不是合法 JSON |
| 401 | `{"ok":false,"error":"unauthorized"}` | 密钥不对 |
| 404 | `{"ok":false,"error":"not found"}` | 路径或方法不对 |
| 413 | `{"ok":false,"error":"body too large"}` | 请求体超过 64KB |

## 十一、语义要点

1. **202 表示「已接受」，不表示「已播报」。** 播报在后台排队进行，migpt 不等它完成就先应答——否则前面排着一段长回复时，HTTP 请求要被挂住几十秒。播报失败（比如音箱离线）只在 migpt 侧打日志，不会回传给外部服务。

2. **提醒会排队，不会打断。** 音箱正在播报 AI 回复时，提醒会等它说完再说。`SpeakerManager` 把所有播报串行化了，因为两股 PCM 流同时写进 `aplay` 会糊在一起。

3. **不会暂停音乐。** 音箱在放音乐时提醒会直接播报，两者混在一起，可能听不清。

4. **推送文本不走分句器**，直接整段合成，所以没有对话通道那条「必须带标点」的约束。

5. **未配置 `AGENT_PUSH_PORT` 时推送服务不启动**，`/push` 不可达。

6. **安全**：`/push` 本质是「让音箱说任意话」的接口。未配置 `AGENT_PUSH_API_KEY` 时不做任何校验，同网络下任何人都能调用，启动时会打印告警。建议配上密钥。

---

# 附录

## 十二、migpt 侧配置（.env）

```bash
# 对话通道
AGENT_BASE_URL=http://127.0.0.1:8000
AGENT_API_KEY=                          # 可选，留空则不发送 Authorization 头
AGENT_SESSION_ID=default                # 可选
AGENT_STREAM=true                       # 可选，是否使用流式
AGENT_TIMEOUT_MS=10000                  # 可选，首个事件超时
AGENT_ERROR_TEXT=出错了，请稍后再试吧     # 可选，兜底话术
AGENT_CALL_KEYWORDS=                    # 可选，留空表示全部转发给外部服务

# 推送通道
AGENT_PUSH_PORT=4400                    # 不配则不启动推送服务
AGENT_PUSH_HOST=0.0.0.0                 # Docker 里必须是 0.0.0.0
AGENT_PUSH_API_KEY=                     # 可选，强烈建议配置
```

改造后 `.env` 里的 `OPENAI_*` 全部可以删除（内置 LLM 已被绕过）；`TTS_*` **必须保留**，那是输出链路。

## 十三、调试示例

对话通道，非流式：

```bash
curl -X POST http://127.0.0.1:8000/chat \
  -H 'Content-Type: application/json' \
  -d '{"request_id":"test-1","session_id":"dev","text":"你好你是谁"}'
```

对话通道，流式（`-N` 关闭缓冲）：

```bash
curl -N -X POST http://127.0.0.1:8000/chat \
  -H 'Content-Type: application/json' \
  -d '{"request_id":"test-1","session_id":"dev","text":"你好你是谁","stream":true}'
```

推送通道（让音箱立刻说话）：

```bash
curl -X POST http://127.0.0.1:4400/push \
  -H 'Content-Type: application/json' \
  -d '{"text":"该吃药了。"}'
```
