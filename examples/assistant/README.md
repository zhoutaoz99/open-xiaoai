# Open-XiaoAI × Assistant

一个纯内存版本的**多轮对话外部服务**，配合 [`examples/migpt`](../migpt) 使用。

接口协议见 [`examples/migpt/PROTOCOL.md`](../migpt/PROTOCOL.md)。

## 这是什么

改造后的 migpt 只负责**唤醒、语音识别、语音播报**，不再自己调大模型：

```
小爱固件            migpt                        assistant（本项目）
─────────           ──────────────────           ──────────────────
唤醒 + ASR   ──▶   拿到识别文字
                   打断小爱
                   POST /chat  ───────────────▶  纯内存多轮上下文
                                                 调用大模型
                   TTS 播报    ◀───────────────  返回文本
                   ─▶ 🔊
```

原来写在 `examples/migpt/src/config.ts` 里的大模型配置（`OPENAI_*`、系统提示词、历史轮数）全部搬到了这里。

## 快速开始

```bash
cd examples/assistant

# 1. 装依赖
pnpm install

# 2. 配置：把原来 examples/migpt/.env 里的 OPENAI_* 搬过来
cp .env.example .env

# 3. 启动
pnpm start
```

启动后：

```
✅ 外部对话服务已启动: http://0.0.0.0:8000
   模型: deepseek-v4-flash
   记忆: 10 轮（纯内存，重启即清空）
```

不接音箱也能直接调：

```bash
curl -N -X POST http://127.0.0.1:8000/chat \
  -H 'Content-Type: application/json' \
  -d '{"request_id":"1","session_id":"dev","text":"你好你是谁","stream":true}'
```

## 和 migpt 对接

两边的配置要对上：

| assistant `.env` | migpt `.env` | 说明 |
| --- | --- | --- |
| `ASSISTANT_PORT=8000` | `AGENT_BASE_URL=http://127.0.0.1:8000` | 地址要指得对 |
| `ASSISTANT_API_KEY=xxx` | `AGENT_API_KEY=xxx` | 要一致，都留空则不校验 |

migpt 侧的 `OPENAI_*` 可以全部删掉（内置大模型已被绕过），`TTS_*` 必须保留。

先起 assistant 再起 migpt。migpt 启动时会探测一次 `/health`，探测失败只告警不阻塞。

## 配置

全部在 `.env` 里，对应 `config.ts`。

**大模型**（和原来 migpt 的配置完全一样，直接搬）：

| 配置 | 说明 |
| --- | --- |
| `OPENAI_API_KEY` | 密钥 |
| `OPENAI_BASE_URL` | 接口地址，一般以 `/v1` 结尾 |
| `OPENAI_MODEL` | 模型名称 |
| `OPENAI_TEMPERATURE` | 温度，删除则用服务商默认值 |
| `OPENAI_THINKING` | 思考模式，DeepSeek 参数格式，其他服务商可能要删掉 |

**多轮对话**：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `ASSISTANT_MAX_TURNS` | 10 | 最多记住多少**轮**（一轮 = 一问一答） |
| `ASSISTANT_SESSION_TTL_MS` | 1800000 | 会话闲置多久后清空 |
| `ASSISTANT_RESET_KEYWORDS` | 重新开始,清空记忆,忘掉刚才 | 说这些话可以清空上下文 |

## 设计要点

### 纯内存

上下文存在一个 `Map<session_id, Session>` 里，**没有任何持久化，进程重启即清空**。闲置超过 `ASSISTANT_SESSION_TTL_MS` 的会话会在下次请求时被回收，避免 Map 无限增长。

`session_id` 由 migpt 侧的 `AGENT_SESSION_ID` 决定，默认 `default`。migpt 同一时刻只服务一个音箱，所以单实例场景下就是一个固定会话。

### 系统提示词默认要求带标点

migpt 侧按 `。？！；?!;` 分句后逐句合成语音，**一段没有标点的长回复在流结束前一个字都播不出来**。所以默认提示词里明确要求模型用口语化短句作答并使用正常标点。改提示词时请保留这条要求。

### 历史按「轮」成对淘汰

提问和回复成对写入、成对淘汰。如果按「条」淘汰，窗口边缘会留下没有提问的孤儿回复，白占一个槽位。

### 失败的请求不污染上下文

发给大模型的消息是临时拼的（`system + 历史 + 本次提问`），**只有成功拿到回复后才把这一轮成对写入历史**。所以调用失败、鉴权失败都不会在上下文里留下垃圾。

### 抢话打断会记录已生成的部分

用户抢话时 migpt 会直接断开 HTTP 连接，本服务据此 abort 大模型请求，并把**已经生成的那部分回复**记进历史。

否则上下文里会留下一条没有回复的提问，下一轮就变成连续两条 `user` 消息。

需要注意的是：由于语音合成比生成慢，**记进历史的部分会比用户实际听到的多一些**。这是个已知的近似。

### 同一会话的请求串行执行

用户抢话时，migpt 会先断开上一条请求再发新的，两条请求可能在服务端交叠。`SessionStore.lock()` 让同一 `session_id` 的请求排队执行，否则历史会写成乱序。

## 换成你自己的 Agent

本服务只做一件事：**收文本 → 出文本**。把 `assistant/server.ts` 里 `chatOnce()` / `chatStream()` 中调用 `this.llm` 的部分换成你自己的逻辑即可，协议层、会话管理、取消处理都不用动。

如果你的 Agent 自带上下文管理，可以直接把 `SessionStore` 摘掉，用 `session_id` 关联到你自己的会话。
