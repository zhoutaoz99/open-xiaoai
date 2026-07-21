# LX06 固件劫持：绕过小米云端实现纯本地语音助手

本文记录在 LX06(小爱音箱 Pro)上绕过小米云端、将音频流劫持到本地助手的完整探索过程。包括设备逆向、音频管线分析、LD_PRELOAD 注入、TLS 证书锁定绕过等关键技术细节。

**状态 (2025-07-21 更新)**: MITM 路线在 ROM 1.94.13 上因 aivs_lab 内嵌 TLS 暂不可行。**推荐方案已切换为 xiaozhi + MiMo ASR**（自定义 KWS 唤醒词 + VAD 端点检测 + MiMo 云端 ASR/TTS + assistant 大模型），完全跳过小爱云，当前固件可用。详见第八节对比和 `examples/xiaozhi/`。

---

## 一、音频管线架构

### 1.1 完整数据流

```
麦克风(pcmC0D3c) → mipns-xiaomi(唤醒+audio采集+opus编码) → speech.usock(IPC)
    → mico_aivs_lab → websocket → 小米云(ASR+NLU+Speak一条龙)
```

关键发现：

- **mipns-xiaomi**(pid 2289)独占所有 ALSA 设备：`pcmC0D3c`(mic fd 31)、`pcmC0D2p`(喇叭 fd 5)、`controlC0`(mixer fd 6)。cmdline: `mipns-xiaomi -c /usr/share/xiaomi/xaudio_engine.conf -r opus32 -l`
- **mico_aivs_lab**(pid 397)不碰任何 snd/pcm——完全通过 `/tmp/mico_aivs_lab/usock/speech.usock`(Unix DGRAM socket, inode 65294)从 mipns 收 audio。mipns 侧对应 `/tmp/mipns/usock/speech.usock`(inode 6319)
- mipns 和 aivs_lab 各开一个 DGRAM socket,互为 client/server。aivs 向 mipns 的 usock 发注册请求,mipns 向 aivs 的 usock 推音频数据
- 唤醒引擎在 mipns 内部(xaudio_engine)自闭环,不依赖云端

### 1.2 xaudio_engine 配置

文件 `/usr/share/xiaomi/xaudio_engine.conf`:
```
[engine opt]
version = xaudio_lx06_1.2.4_0;
[wakeup opt]
model_path = /usr/share/xiaomi/wakeup_model.bin;
version = kws_s12a_1.1.7_0;
[vad opt]
model_path = /usr/share/xiaomi/;
version = vad_kws_s12a_1.1.7_0;
timeout_num = 600;
```

配置目录 `/usr/share/xiaomi/` 含 DNN VAD/WE 模型文件。

### 1.3 云端连接 IP

aivs_lab 不从 DNS 解析(读缓存 `/data/mipns/aivs_config`)。实际连接的目标端口和 IP：

| 端口 | IP | 用途 |
|------|-----|------|
| 80 | 39.102.218.12 | HTTP token/auth/配置 |
| 443 | 111.202.1.126, 111.202.0.131, 111.206.191.182, 111.206.101.154, 111.206.191.193, 110.43.0.170 等 | WebSocket TLS(音频+ASR+NLU+Speak) |

TLS 参数(真云端 `speech.ai.xiaomi.com:443`):
- 协议：**TLSv1.2**
- 密码套件：**ECDHE-RSA-AES256-GCM-SHA384**
- ALPN：无协商
- 证书：GoDaddy 签发,CN=speech.ai.xiaomi.com
- SHA-256 指纹：`2A:C6:95:FF:D0:44:8E:C0:A9:0E:77:FF:CB:39:0A:DC:D4:6D:76:92:39:6A:CB:D1:F0:CA:CE:55:F7:1A:FD:3C`

---

## 二、设备访问方式

### SSH

音箱 LX06(192.168.1.25),root 登录。老设备需加旧算法：

```bash
ssh -o HostKeyAlgorithms=+ssh-rsa \
    -o PubkeyAcceptedAlgorithms=+ssh-rsa \
    -o KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group1-sha1,diffie-hellman-group-exchange-sha1 \
    root@192.168.1.25
```

### 关键坑

- **busybox**：无 `nohup`(后台进程需靠 local ssh 保持连接)、无 `date %N`(亚秒计时用 `/proc/uptime`)、无 `openssl`、无 `base64`
- **/etc/hosts 只读**(overlayfs,无法直接修改 DNS)
- **iptables 无 NAT 模块**(`nat` 表不存在,无法 DNAT)
- **文件系统**：`/tmp` 可写,用于存放编译产物和日志
- **HTTP 传输**：设备有 `wget`,Mac 起 `python3 -m http.server` 即可传文件

---

## 三、原生提醒/闹钟控制

### 3.1 ubus alarm 对象

小爱原生「提醒」和「闹钟」共用 `alarm` ubus 对象(type="alarm")。关键命令：

```bash
# 查询全部
ubus call alarm query '{"type":"alarm"}'

# 删除指定 id
ubus call alarm delete '{"type":"alarm","id":"<uuid>"}'
```

查询返回的 `info` 是**转义过的 JSON 字符串**(两层解析)。在 shell 中用 UUID 正则提取：
```bash
grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
```

### 3.2 提醒 vs 闹钟字段区分

| | event 字段 | 铃声字段 |
|---|---|---|
| 提醒 | 非空(如"吃药") | 无 |
| 闹钟 | 空字符串 | 有 ringtone_query/ringtone_type |

### 3.3 创建时机

实测：小爱云端根据**流式识别**建提醒,在 ASR 定稿(`RecognizeResult is_final=true`,即 onMessage 触发点)之前约 0.4-1 秒已经落到 alarm 存储。波动取决于云端延迟,约在 onMessage 前后 ±1 秒。

### 3.4 instruction.log 中的 SetAlert

云端下发的建提醒指令在 `instruction.log` 中格式：
```json
{"header":{"name":"SetAlert","namespace":"Alerts"}, "payload":{"datetime":"...","event":"吃药","id":"<uuid>"}}
```
但在真实语音流程中 SetAlert 并不一定出现在日志中(与直接 NLU 注入的路径不同),不可靠。

---

## 四、LD_PRELOAD 注入方案

### 4.1 方案选型

三套方案对比：

| 方案 | 可行性 | 复杂度 | 说明 |
|------|--------|--------|------|
| /etc/hosts 重定向 | ❌ 不可行 | — | 文件系统只读 |
| iptables DNAT | ❌ 不可行 | — | 无 nat 模块 |
| **LD_PRELOAD hook connect()** | ✅ 可行 | 中 | 需交叉编译 ARM32 .so,劫持 connect() syscall |
| LD_PRELOAD hook getaddrinfo() | ❌ 无效 | — | aivs 读缓存 IP,不走 DNS |

采用 **LD_PRELOAD hook connect()**,将所有出站 443 和 80 端口连接重定向到 Mac 代理。

### 4.2 交叉编译环境

- 编译机器：macOS(Apple Silicon),clang 21.0
- 目标架构：**ARM 32-bit hard-float**(`arm-linux-gnueabihf`)
- 内核是 aarch64,用户态是 32 位(`ld-linux-armhf.so.3`)
- 需要 Homebrew 安装 `llvm` + `lld`

编译命令：
```bash
clang --target=arm-linux-gnueabihf -shared -fPIC -nostdlib \
  -fuse-ld=/opt/homebrew/bin/ld.lld \
  -o redirect_connect.so redirect_connect.c
```

注意事项：
- `-nostdlib`:不链接 libc,所有函数自实现或通过 dlsym 动态查找
- `open()` 在 ARM32 上 variadic ABI 不同——用 2 参数形式(`O_WRONLY|O_APPEND`)代替 3 参数(`O_CREAT|mode`)
- 文件传输：Mac 上 `python3 -m http.server 8888`,设备上 `wget -qO /tmp/XXX http://192.168.1.200:8888/XXX`

### 4.3 connect() hook 实现

重定向所有 :443 和 :80 出站连接到 Mac 代理(192.168.1.200)。443→9443(TLS),80→9080(HTTP)。

```c
if (port == 443 || port == 80) {
    sin->sin_addr.s_addr = inet_addr("192.168.1.200");
    uint16_t new_port = (port == 443) ? 9443 : 9080;
    sin->sin_port = ((new_port & 0xFF) << 8) | ((new_port >> 8) & 0xFF);
}
```

### 4.4 注入方式

```bash
# 改名 init 脚本防止 procd 自动重启
mv /etc/init.d/mico_aivs_lab /etc/init.d/_mico_aivs_lab
# 带 LD_PRELOAD 启动
LD_PRELOAD=/tmp/redirect_connect.so /usr/bin/mico_aivs_lab &
# 测试完后恢复
mv /etc/init.d/_mico_aivs_lab /etc/init.d/mico_aivs_lab
/etc/init.d/mico_aivs_lab start
```

---

## 五、TLS 证书锁定绕过

### 5.1 诊断过程

经过多轮 LD_PRELOAD hook 注入诊断,定位到 aivs_lab 的证书验证调用链：

```
SSL_CTX_set_verify  →  设置 VERIFY_NONE(绕过)
TLS handshake       →  完成
X509_get_pubkey     →  获取对端证书公钥(3 次调用)
memcmp(32 bytes)    →  比较 SHA-256 指纹 ← 证书锁定检查点
SSL_shutdown        →  不匹配则立即关闭
```

关键：aivs_lab 在 OpenSSL 之外自己做 SHA-256 公钥指纹比对,绕过 `SSL_CTX_set_verify` 和 `SSL_get_verify_result` 不够。

### 5.2 绕过方案：公钥替换

在 `X509_get_pubkey` hook 中,不返回自签证书的公钥,而是解析嵌入的真 Xiaomi 证书 DER,返回其公钥。aivs 对返回的公钥做 SHA-256,与硬编码的 real fingerprint 比对 → 匹配通过。

实现要点：
1. 真证书 DER(1706 字节)硬编码在 `.so` 中
2. 每次 `X509_get_pubkey` 被调用时,通过 dlsym 找 `d2i_X509` 解析 DER
3. 调用真实的 `X509_get_pubkey(real_cert)` 获取真公钥并返回
4. 必须每次重新解析(不能缓存)——OpenSSL 引用计数,缓存会导致 double-free
5. 调用 `X509_free` 释放临时的 X509 对象

```c
void *X509_get_pubkey(void *cert) {
    d2i_X509_fn d2i = dlsym(RTLD_NEXT, "d2i_X509");
    x509_get_pubkey_fn getpk = dlsym(RTLD_NEXT, "X509_get_pubkey");
    const unsigned char *p = kRealCertDER;
    void *real_cert = d2i(0, &p, 1706);
    void *pk = getpk(real_cert);
    x509_free_fn xfree = dlsym(RTLD_NEXT, "X509_free");
    if (xfree) xfree(real_cert);
    return pk;
}
```

### 5.3 完整的 SSL hook 列表

| Hook 函数 | 作用 | 返回值 |
|-----------|------|--------|
| `SSL_CTX_set_verify` | 设置 VERIFY_NONE,清空回调 | — |
| `SSL_get_verify_result` | 返回验证通过 | 0 (X509_V_OK) |
| `X509_get_pubkey` | **返回真证书公钥** | 真 pubkey |
| `SSL_get_peer_certificate` | 返回 NULL | NULL |
| `SSL_get1_peer_certificate` | 返回 NULL | NULL |
| `X509_check_host` | 跳过 hostname 检查 | 1 (匹配) |

### 5.4 证书要求

自签证书必须满足(aivs 的域名通配符匹配规则)：
- CN 或 SAN 含 `speech.ai.xiaomi.com`(通配符 `*.speech.ai.xiaomi.com` 不匹配裸域名)
- 生成命令：
```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 1 -nodes \
  -subj "/CN=speech.ai.xiaomi.com" \
  -addext "subjectAltName=DNS:speech.ai.xiaomi.com,DNS:*.speech.ai.xiaomi.com"
```

### 5.5 TLS 参数要求

必须与真云端完全匹配：
- **TLS 版本**：仅 TLSv1.2(禁用 TLSv1.3)
- **密码套件**：`ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-GCM-SHA256`
- **honorCipherOrder**: true

---

## 六、代理架构

### 6.1 双端口转发

```
aivs_lab ──→ 我们的 Mac(192.168.1.200)
              ├── :9080(HTTP forward) → 39.102.218.12:80(token/auth)
              └── :9443(TLS MITM)     → speech.ai.xiaomi.com:443(音频流)
```

### 6.2 HTTP 转发(端口 80)

已验证稳定工作：连接保持 29.5 秒,双向数据传输(2455B↑ / 1557B↓)。

### 6.3 TLS/MITM 代理(端口 443)

**当前状态**：TLS 握手成功、证书锁定绕过生效、aivs 在匹配的 TLS 参数下发送应用数据。

**关键突破**：使用 `openssl s_server -debug` 替代 Node.js TLS 后,aivs_lab 完成了完整的 TLS 握手并发送应用数据。连接 #4 的完整流程：

```
ACCEPT
read  5B   (TLS record header)
read  512B (ClientHello)
write 96B  (ServerHello)
write 783B (Certificate)
write 338B (ServerKeyExchange)
write 9B   (ServerHelloDone)
read  5B   (ClientKeyExchange header)
read  102B (ClientKeyExchange)
read  1B   (ChangeCipherSpec)
read  40B  (Finished)
write 207B (NewSessionTicket + ChangeCipherSpec)
write 51B  (Finished)
CIPHER is ECDHE-RSA-AES256-GCM-SHA384
```

前 3 个连接 aivs 主动关闭(快速探测),第 4 个连接握手成功并开始传输。这证明：**aivs 在做多轮 TLS 协商,找到匹配的参数后才发送数据。**

### 6.4 Node.js TLS vs openssl s_server

Node.js 的 TLS 实现在某些参数上与 openssl 不同,导致 aivs 的连接全部秒断。openssl s_server 的 `-www` 模式使 aivs 完成了握手。差异可能在于：
- TLS 扩展(Extended Master Secret, Session Ticket 等)
- 证书链格式
- 密码套件协商细节

---

## 七、调试工具与技巧

### 7.1 strace

```bash
strace -f -e trace=network,read,write -xx -s 512 -o /tmp/log -p <pid>
```

### 7.2 进程信息

```bash
# 打开的文件描述符
ls -la /proc/<pid>/fd | grep -E 'snd|pcm|socket|pipe|usock'

# 内存映射(验证 LD_PRELOAD 注入)
grep redirect /proc/<pid>/maps

# TCP 连接
cat /proc/net/tcp
```

### 7.3 LD_PRELOAD 诊断日志

在 `.so` 中用 `write()`+`open()` 写 `/tmp/connect.log`,不用 libc 的 `fprintf`(因编译 `-nostdlib`)。

```c
static void wlog(const char *msg) {
    int len = slen(msg);
    int fd = open("/tmp/connect.log", 02001); /* O_WRONLY|O_APPEND, 2-arg no O_CREAT */
    if (fd >= 0) { write(fd, msg, len); write(fd, "\n", 1); close(fd); }
}
```

文件需预创建：`touch /tmp/connect.log; chmod 666 /tmp/connect.log`

### 7.4 TLS 诊断

```bash
# 检查真云端 TLS 参数
echo | openssl s_client -connect speech.ai.xiaomi.com:443 -servername speech.ai.xiaomi.com 2>&1 | grep -E 'Protocol|Cipher|ALPN'

# 提取证书
echo | openssl s_client -connect speech.ai.xiaomi.com:443 -showcerts 2>&1 | awk '/BEGIN/,/END/' > chain.pem

# 证书指纹
openssl x509 -in cert.pem -noout -fingerprint -sha256

# 公钥指纹(用于锁定绕过)
openssl x509 -in cert.pem -noout -pubkey | openssl pkey -pubin -outform DER | xxd -p | tr -d '\n'
```

### 7.5 openssl s_server 详细调试

```bash
openssl s_server -cert cert.pem -key key.pem \
  -tls1_2 -cipher 'ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256' \
  -accept 9443 -debug 2>/tmp/log
```

---

## 八、三种替代小爱原生 ASR 的路线对比

### 8.1 核心差异

三种方案都旨在替代小爱原生 ASR 并交给本地助手处理，但**拦截点和依赖不同**：

| | 固件劫持 (MITM) | migpt (文字截获) | xiaozhi + MiMo ASR |
|---|---|---|---|
| **拦截位置** | aivs_lab → TLS 连接之前 (connect 重定向) | aivs_lab 从云端拿到文字之后，tail instruction.log | 麦克风 PCM 音频，mipns 采集后、进 aivs 之前 |
| **数据流** | 麦克风 → mipns → aivs → **劫持** → 本地代理 → /chat | 麦克风 → mipns → aivs → 小米云 ASR → aivs → **migpt 截获文字** → /chat | 麦克风 → mipns → **open-xiaoai Rust client** → KWS+VAD → **MiMo ASR** → assistant /chat → **MiMo TTS** → aplay |
| **唤醒词** | 小爱原生 | 小爱原生 | 自定义 KWS (sherpa-onnx 本地) |
| **ASR 由谁做** | 自建本地 ASR (拟) | 小爱云端 | MiMo 云端 (独立于小爱) |
| **需要绕过 TLS?** | **是** (证书锁定) | 否 | 否 |
| **依赖小米云?** | 否 | **是** (ASR 文字) | **否** |
| **支持当前固件?** | **否** (aivs 内嵌 TLS) | 是 | **是** |
| **原生回复干扰** | 无 | 需 `abortXiaoAI` 打断 | 无 (不进原生对话链路) |
| **离线能力** | 可离线 | 需联网 | 需联网 |
| **复杂度** | 极高 | 中 | 中 |
| **当前状态** | 暂停 | 可用 | **可用 (推荐)** |

### 8.2 为什么固件劫持路线在当前固件不可行

在 ROM 1.94.13 上通过 `strace` 证实：aivs_lab 直接通过 `write(fd, raw_tls_record)` 发送原始 TLS 字节流，不通过 PLT 调用 OpenSSL (`SSL_CTX_set_verify`, `X509_get_pubkey`) 或 mbedTLS (`mbedtls_ssl_handshake`)。这意味着 LD_PRELOAD 的函数 hook 方式无法拦截证书锁定检查逻辑——代码内嵌在 aivs 二进制中，不走动态链接器。

前一个阶段成功绕过的版本可能是较早固件（使用动态链接的 OpenSSL 进行 TLS）。

### 8.3 xiaozhi + MiMo ASR 方案详解（推荐）

这是目前已完整实现并验证可用的方案。核心思路：**不复用小爱原生的任何云端能力，从麦克风 PCM 音频开始建立完全独立的 ASR 管线**。

#### 8.3.1 完整数据流

```
麦克风 (pcmC0D3c)
    │
    └─→ mipns-xiaomi (照常运行，但不使用其输出)
    │
    └─→ open-xiaoai Rust client (on_input_data 回调)
            │ PCM16 16kHz
            ▼
        GlobalStream
            │
            ├─→ KWS (sherpa-onnx)         ← 本地唤醒词检测
            │       检测到"你好小智"
            │           │
            │           ▼  EventManager.wakeup()
            │           │
            ├─→ VAD (silero-vad)           ← 本地语音端点检测
            │       检测 speech_start → 开始收集 PCM
            │       检测 silence      → 停止收集
            │           │
            │           ▼  PCM bytes (完整一句话)
            │
            └─→ MiMo ASR                 ← 云端语音转文字
                    POST /v1/chat/completions
                    model: mimo-v2.5-asr
                    language: zh
                        │
                        ▼  text (识别文字)
                AgentConnector            ← HTTP SSE 对接 assistant
                    POST /chat
                    SSE: delta/done
                        │
                        ▼  text (AI 回复)
                MiMo TTS                  ← 云端文字转语音
                    POST /v1/chat/completions
                    model: mimo-v2.5-tts
                    stream: true
                        │
                        ▼  PCM16 bytes
                GlobalStream.output()
                        │
                        ▼
                open-xiaoai Rust client → aplay → 扬声器
```

#### 8.3.2 关键组件

| 组件 | 位置 | 作用 | 模型/API |
|------|------|------|----------|
| **KWS 唤醒词检测** | 本地 (sherpa-onnx) | 检测自定义唤醒词 | encoder/decoder/joiner.onnx (~20MB) |
| **VAD 端点检测** | 本地 (silero-vad) | 判断说话开始和结束 | silero_vad.onnx (~1.8MB) |
| **MiMo ASR** | 云端 (MiMo API) | 语音转文字 | mimo-v2.5-asr |
| **AgentConnector** | 本地 HTTP | 对接 assistant 大模型 | POST /chat (SSE 流式) |
| **MiMo TTS** | 云端 (MiMo API) | 文字转语音 | mimo-v2.5-tts |
| **音频 I/O** | open-xiaoai Rust client | 音箱端采集和播放 | ALSA / aplay |

#### 8.3.3 与 migpt 的本质区别

| | migpt | xiaozhi + MiMo ASR |
|---|---|---|
| **拿到的数据类型** | 文字 (ASR 结果) | 原始音频 (PCM) |
| **ASR 归属** | 小爱云端 | 自建 (MiMo) |
| **能否离线** | 否 | 否 (但 ASR 可替换为本地方案) |
| **唤醒词** | 只能用"小爱同学" | 自定义，可配置多个 |
| **小爱云依赖** | 完全依赖 | 零依赖 |
| **适用场景** | 保留小爱原生体验 + 劫持回复 | 完全替代小爱，自建语音助手 |

#### 8.3.4 部署架构

```
┌─────────────┐     WebSocket :4399     ┌─────────────┐
│ 小爱音箱     │ ◄────────────────────── │ xiaozhi      │
│ (Rust client)│     PCM + 事件           │ (Python)     │
└─────────────┘                         │              │
                                        │ KWS + VAD    │
                                        │ MiMo ASR     │
                                        │ MiMo TTS     │
                                        │ AgentConnector│
                                        └──────┬───────┘
                                               │ HTTP SSE
                                               ▼
                                        ┌─────────────┐
                                        │ assistant    │
                                        │ (大模型 agent)│
                                        │ 多轮上下文    │
                                        │ 工具调用      │
                                        └─────────────┘
```

#### 8.3.5 音箱灯效与提示音集成

xiaozhi 方案绕过原生语音链路后，音箱的 LED 灯效和唤醒提示音也需要通过固件侧命令手动控制。以下是基于 LX06 ROM 1.94.13 实测的完整方案。

##### 原生唤醒流程参考

真实唤醒时 mipns-xiaomi 会依次调用 `/bin/wakeup.sh` 的三个子命令：

```
mipns 检测到唤醒词
  → wakeup.sh WuW        → player_wakeup start + voip_helper（只放"叮"提示音，不管灯）
  → wakeup.sh bf <angle> → /bin/show_led 1 <angle>（亮灯，进入收音阶段）
  → wakeup.sh think      → /bin/show_led 2（思考中）
  → wakeup.sh speek      → /bin/show_led 3（说话中）
  → wakeup.sh ready      → shut_led + player_wakeup stop（清理，灭灯）
```

关键设计原则：**放音和亮灯是分离的两个步骤**，由 mipns 在不同时间点分别触发。提示音先播（此时灯是灭的），等波束成形完成后才亮灯进入收音。

##### 灯效控制

设备上有两套灯控系统：

| 系统 | 命令 | 用途 |
|------|------|------|
| `led` (ubus) | `/bin/show_led N` / `/bin/shut_led N` | 系统灯效：唤醒(1)、思考(2)、说话(3) |
| `playled` (mediaplayer) | `player_wakeup` 内部管理 | 媒体播放灯效，会和 `led` 互相覆盖 |

**踩坑记录**：`player_play_url`（播 URL）走的是 mediaplayer 通用播放路径，启动时会覆盖 `show_led` 设置的灯效（显示播放灯 type=3），播完后又会清理——导致之前设置的唤醒灯也被清空。原生用的 `player_wakeup start` 则走专用路径，完全不碰 `led` 对象。

**最终方案**：直接使用固件原生的 `/bin/show_led 1` 控制唤醒灯，`/bin/shut_led 1` 灭灯。这是 `wakeup.sh bf` 内部调用的同一条命令，和原生完全一致。

可用灯效场景（来自 `wakeup.sh`）：

| LED 场景 | 命令 | 含义 |
|----------|------|------|
| 1 | `show_led 1` | 唤醒/波束成形方向指示 |
| 2 | `show_led 2` | 思考中 (ASR/Agent 处理) |
| 3 | `show_led 3` | 说话中 (TTS 播放) |
| 9 | `show_led 9` | 无角度指示 |
| 11 | `show_led 11` | 就绪/待命 |

查询当前灯效：`ubus call led status`；关闭所有：`ubus call led shut_all`。

##### 提示音播放

提示音使用本地 opus/wav 文件通过 `player_play_url` 播放（即时，无网络延迟）。**必须先放音、后亮灯**，顺序和原生一致，避免 mediaplayer 的播放灯效覆盖唤醒灯。

```python
# 原生顺序：先放音（灯灭），再亮灯（收音）
await speaker.run_shell(
    "ubus call mediaplayer player_play_url "
    "'{\"url\":\"file:///usr/share/sound-vendor/AiNiRobot/wakeup_ei_01.wav\",\"type\":1}'"
)
await asyncio.sleep(0.8)  # 等提示音播完 + mediaplayer 清理落定
await speaker.run_shell("/bin/show_led 1")
```

设备上现成的提示音文件：

| 文件 | 内容 |
|------|------|
| `wakeup_ei_01.wav` | 诶 |
| `wakeup_zai_01.wav` | 在 |
| `wakeup_wozai.wav` | 我在 |
| `tip_zaine.opus` | 在呢 |
| `tip_shuoba.opus` | 说吧 |

要使用自定义语音（如"你好主人"），可通过 MiMo TTS 生成 wav 后上传到音箱的 `/data/open-xiaoai/` 目录，再将 URL 改为 `file:///data/open-xiaoai/xxx.wav`。

##### TTS 播完提示音（多轮对话"滴"）

原生多轮对话中，TTS 播完后会播放一个短促的"滴"提示音，告知用户可以继续说话。该提示音来自 `wakeup.sh multirounds` 分支：

```bash
# /bin/wakeup.sh 中的 multirounds 分支
multirounds)
    ubus -t 1 call qplayer play '{"play":"/usr/share/common_sound/multirounds_tone.opus"}'
    ubus -t 1 call mediaplayer player_wakeup '{"action":"multistart"}'
    ;;
```

**提示音文件**：`/usr/share/common_sound/multirounds_tone.opus`（OGG Opus, mono, 16kHz, 约 0.92 秒）

**播放方式**：直接通过 `run_shell` 在设备端调用 `qplayer` 播放设备上已有的文件，**无需下载到本地**。与原生 `wakeup.sh multirounds` 使用同一文件和播放器。

```python
# xiaozhi/xiaozhi.py _play_beep()
sound = cfg.get("sound", "/usr/share/common_sound/multirounds_tone.opus")
res = await speaker.run_shell(f"qplayer {sound}", timeout=5000)
```

设备不可用时（如 CLI 模式无设备连接），fallback 到本地生成正弦波通过 `GlobalStream.output()` 播放。

**调用时机**：在 `_handle_wakeup()` 中，TTS 音频播完（`_play_audio` 返回）之后、`continue_listening()` 之前播放。

**与原生流程的对比**：

| | 原生 `wakeup.sh multirounds` | 当前实现 |
|---|---|---|
| 触发方式 | mipns 内部调用 | Python 侧 `run_shell("qplayer ...")` |
| 播放器 | `qplayer`（ubus call） | `qplayer`（直接命令行） |
| 提示音来源 | `/usr/share/common_sound/multirounds_tone.opus` | 同一文件 |
| LED 副作用 | 无（qplayer 不碰 LED） | 无 |
| 本地文件依赖 | — | 无（直接播放设备上的文件） |

**踩坑**：
- 设备无 sftp-server，`scp` 默认模式会失败，需用 `-O`（legacy SCP 协议）才能下载文件
- 设备上的 `.opus` 文件是 OGG 容器格式（非裸 opus 帧），不能直接用 `opuslib` 逐帧解码
- `expect` 传输二进制文件会损坏数据（buffer 编码问题），必须用 `scp -O`
- 最终方案无需下载：直接 `qplayer` 播放设备上的文件，最简单且与原生一致
- 提示音约 0.92 秒，加上 VAD 的 `debounce_duration: 400ms`，总延迟约 1.3 秒后才开始收音，可接受

##### KWS 状态污染与重置

**问题**：TTS 回复播放时音频经空气传到麦克风，被 KWS（sherpa-onnx）的 stream 持续接收。虽然 KWS 在 `LISTENING`/`SPEAKING` 状态跳过处理，但音频仍会进入 `MyStream` 缓冲区。当 device_state 恢复 `IDLE` 后，KWS 开始消费缓冲的 TTS 音频——这些音频虽不匹配唤醒词，但会导致 sherpa-onnx 的 encoder 内部状态被连续语音"填满"，后续真实唤醒词无法被可靠检测。

**解决**：每次 pipeline 结束后调用 `KWS.reset()`，同时清空 `MyStream` 的音频缓冲和 sherpa-onnx 的 `KeywordSpotter` stream，确保每次唤醒检测从干净状态开始。

```python
# xiaozhi.py _handle_wakeup() 中
self.device_state = DeviceState.IDLE
await get_speaker().run_shell("/bin/shut_led 1")
KWS.reset()  # 清空音频缓冲 + 重置 sherpa-onnx stream
```

##### LED 亮度异常（夜间模式 imax 不恢复）

**现象**：LED 灯效突然变暗，不仅自定义 `show_led 1` 暗，连原生"小爱同学"唤醒灯也暗。通常发生在夜间模式时间窗口（默认 22:10~07:10）过后。

**根因**：LX06 的 LED 由 AW20054 I2C 驱动芯片控制（`/sys/devices/i2c-0/0-003a/`）。`ledserver` 进入夜间模式时会降低芯片的全局最大电流寄存器 `led_imax`（从 `0x07`/160mA 降到 `0x06`/120mA），但退出夜间模式后**不会自动恢复**，导致亮度永久降低。

**排查步骤**：

```bash
# 1. 查看当前 imax 值
cat /sys/devices/i2c-0/0-003a/led_imax
# 正常输出: current imax = 0x07, value = AW20054_IMAX_160mA
# 异常输出: current imax = 0x06, value = AW20054_IMAX_120mA

# 2. 查看夜间模式配置
cat /data/etc/nightmode.cfg
# light = "night" 表示 LED 参与夜间降亮

# 3. 直接写寄存器验证（绕过 ledserver）
echo r 0xff > /sys/devices/i2c-0/0-003a/led_fade
echo g 0xff > /sys/devices/i2c-0/0-003a/led_fade
echo b 0xff > /sys/devices/i2c-0/0-003a/led_fade
echo 0 0x00ff00 > /sys/devices/i2c-0/0-003a/led_rgb
# 如果仍然暗，说明是 imax 问题
```

**修复**：

```bash
# 即时修复：恢复 imax 到 160mA
echo 0x07 > /sys/devices/i2c-0/0-003a/led_imax

# 持久化：写入 /data/init.sh（重启后自动恢复）
echo 'echo 0x07 > /sys/devices/i2c-0/0-003a/led_imax 2>/dev/null || true' >> /data/init.sh

# 可选：禁止夜间模式降低 LED 亮度
sed -i 's/light = "night"/light = "normal"/' /data/etc/nightmode.cfg
```

**AW20054 关键 sysfs 接口**（`/sys/devices/i2c-0/0-003a/`）：

| 文件 | 用途 | 示例 |
|------|------|------|
| `led_rgb` | 设置单颗 LED 颜色 | `echo 0 0x00ff00 > led_rgb`（第 0 颗，绿色） |
| `led_fade` | 渐变亮度（r/g/b 通道） | `echo r 0xff > led_fade`（红色通道满亮） |
| `led_imax` | 全局最大电流 | `echo 0x07 > led_imax`（160mA） |
| `led_hwen` | 硬件使能 | `1` = 开启 |
| `led_position` | LED 数量 | `16`（LX06 顶部 16 颗 RGB） |

**imax 对照表**：

| 值 | 电流 |
|----|------|
| `0x06` | 120mA（夜间模式） |
| `0x07` | 160mA（正常亮度） |

##### 完整的交互生命周期

```
唤醒词
  → KWS 检测 → pause KWS
  → before_wakeup: 放提示音 → sleep(0.8s) → show_led 1
  → resume KWS, state=IDLE
  → VAD 收音 → 采集 PCM → on_wakeup
  → _handle_wakeup: state=LISTENING → pipeline.run()
      → ASR → Agent → TTS(streaming, state=SPEAKING)
  → TTS 播完:
      ① _play_beep: qplayer 播放设备上的 multirounds_tone.opus（"滴"，~0.92s）
      ② continue_listening → VAD 等待下一轮语音
  → 多轮超时或无语音:
      ① shut_led 1（灭灯）
      ② state=IDLE（恢复 KWS 帧处理）
      ③ KWS.reset()（清空 sherpa stream + 音频缓冲）
```

##### 与原生方案的差距

| 能力 | 原生 | 当前实现 | 原因 |
|------|------|----------|------|
| LED 灯效 | `show_led 1` | `show_led 1` | ✅ 完全相同 |
| 唤醒提示音 | mipns DSP 内部播放 | `player_play_url` 本地文件 | 原生无外部触发入口，但效果等价 |
| 多轮"滴"提示音 | `qplayer multirounds_tone.opus` | `run_shell("qplayer ...")` 播放同一文件 | ✅ 完全相同，无需下载到本地 |
| 回音消除 (AEC) | xaudio_engine DSP | 无 | arecord 从 `hw:0,3` 读原始 PDM，AEC 在 mipns 内存内闭环 |
| 波束成形 | xaudio_engine 8ch→1ch | 8ch 简单下采样 | 同上，arecord 拿不到 DSP 加工后的数据 |

AEC 的缺失意味着播放提示音或 TTS 回复时必须等声音在空气中完全消散后才能开始收音——当前通过 `asyncio.sleep(0.8)` 延迟 VAD 启动来规避。

### 8.4 下一步

1. **xiaozhi + MiMo ASR (推荐)**：当前唯一完全独立于小爱云的可用方案，见 `examples/xiaozhi/`
2. **仍维护 migpt 路线**：如果偏好保留小爱原生唤醒和 ASR 体验，见 `examples/migpt/`
3. **本地 ASR 终极方案 (长期)**：将 MiMo ASR 替换为本地模型 (whisper.cpp / FunASR)，实现完全离线

## 九、相关文件索引

| 文件 | 说明 |
|------|------|
| **固件劫持 (MITM)** | |
| `scratchpad/redirect_connect.c` | LD_PRELOAD .so 源码 (connect 重定向 + 诊断 hook) |
| `scratchpad/real_cert_der.inc` | 真 Xiaomi 证书 DER 数组 (make-cert.js 生成, 1706 字节) |
| `scratchpad/make-cert.js` | 一键: 生成自签 cert/key + 提取真证书 + 生成 .inc |
| `scratchpad/build.sh` | 交叉编译 redirect_connect.so (arm-linux-gnueabihf, -nostdlib) |
| `scratchpad/deploy.sh` | 完整部署: cert → 编译 → 上传 → 注入 → 验证 |
| `scratchpad/tls-debug.sh` | TLS 调试对比工具 (openssl s_server vs Node.js) |
| `scratchpad/httpfwd.py` | HTTP 透明转发代理 (双栈 socket, 9080→39.102.218.12:80) |
| `scratchpad/echo.py` | Python TLS echo 服务器 (TLSv1.2, 双栈 socket) |
| `scratchpad/proxy.js` | Node.js TLS MITM 代理 (未验证) |
| `scratchpad/sshexec.exp` | Expect 脚本: 密码认证 SSH |
| `scratchpad/rcmd.sh` | 设备端远程命令 (注入/恢复/状态/日志) |
| **xiaozhi + MiMo ASR** | |
| `examples/xiaozhi/xiaozhi/xiaozhi.py` | 主控 (KWS+VAD、Pipeline 编排) |
| `examples/xiaozhi/xiaozhi/pipeline.py` | Pipeline + AgentConnector (ASR→Agent→TTS) |
| `examples/xiaozhi/xiaozhi/services/asr/mimo.py` | MiMo ASR 客户端 |
| `examples/xiaozhi/xiaozhi/services/tts/mimo.py` | MiMo TTS 客户端 |
| `examples/xiaozhi/xiaozhi/event.py` | KWS 触发 → VAD 语音捕获 |
| `examples/xiaozhi/xiaozhi/services/audio/kws/` | 自定义唤醒词 (sherpa-onnx) |
| `examples/xiaozhi/xiaozhi/services/audio/vad/` | VAD 端点检测 (silero-vad) |
| `examples/xiaozhi/config.py` | 唤醒词 + VAD 参数 |
| `examples/xiaozhi/.env.example` | 环境变量模板 (API Key、assistant 地址) |
| **migpt (文字截获)** | |
| `examples/migpt/src/speaker.ts` | migpt 侧: abort/player_stop/alarm 清理 |
| `examples/migpt/src/config.ts` | migpt 侧: ABORT_MODE + SUPPRESS_NATIVE_REMINDER |
| `examples/migpt/src/agent.ts` | migpt 侧: AgentManager (SSE 流式对接外部服务) |
| `examples/migpt/PROTOCOL.md` | 外部对话服务接口协议 |
| **xiaozhi + MiMo ASR (推荐)** | |
| `examples/xiaozhi/xiaozhi/xiaozhi.py` | 主控: KWS+VAD 启动、Pipeline 编排 |
| `examples/xiaozhi/xiaozhi/pipeline.py` | Pipeline + AgentConnector: ASR→Agent→TTS |
| `examples/xiaozhi/xiaozhi/services/asr/mimo.py` | MiMo ASR 客户端 (PCM16→WAV→API) |
| `examples/xiaozhi/xiaozhi/services/tts/mimo.py` | MiMo TTS 客户端 (流式合成) |
| `examples/xiaozhi/xiaozhi/event.py` | 事件管理: KWS 触发→VAD 语音捕获 |
| `examples/xiaozhi/xiaozhi/services/audio/kws/` | 自定义唤醒词 (sherpa-onnx) |
| `examples/xiaozhi/xiaozhi/services/audio/vad/` | VAD 端点检测 (silero-vad) |
| `examples/xiaozhi/config.py` | 唤醒词 + VAD 参数配置 |
| `examples/xiaozhi/.env.example` | 环境变量模板 (MiMo API Key、assistant 地址等) |
| `examples/xiaozhi/xiaozhi/utils/audio.py` | 正弦波提示音生成 (设备不可用时 fallback) |
| **助手服务** | |
| `examples/assistant/apps/api/` | 大模型 agent 服务 (对话、记忆、待办) |
| `examples/assistant/docs/todo.md` | 待办模块设计(含原生提醒拦截) |

---

## 十、关键命令速查

### 固件劫持 (MITM)

```bash
# 生成证书 + 提取真证书 DER
cd scratchpad
node make-cert.js

# 编译 LD_PRELOAD .so
./build.sh

# 传输到设备
python3 -m http.server 8888 &
# 设备端: wget -qO /tmp/redirect_connect.so http://192.168.1.200:8888/redirect_connect.so

# 注入启动
killall -9 mico_aivs_lab; sleep 2
mv /etc/init.d/mico_aivs_lab /etc/init.d/_mico_aivs_lab
LD_PRELOAD=/tmp/redirect_connect.so /usr/bin/mico_aivs_lab &

# 验证注入
grep redirect /proc/$(pgrep mico_aivs_lab)/maps

# 恢复
mv /etc/init.d/_mico_aivs_lab /etc/init.d/mico_aivs_lab
/etc/init.d/mico_aivs_lab start

# 启动代理 (使用 Python 双栈版本, macOS 外部可达)
python3 -u httpfwd.py 9080 > /tmp/httpfwd.log 2>&1 &    # HTTP 转发
python3 -u echo.py 9443 > /tmp/echo.log 2>&1 &          # TLS echo 测试

# 查看设备日志
cat /tmp/connect.log   # LD_PRELOAD 诊断
cat /tmp/echo.log      # echo 服务器
cat /tmp/proxy.log     # MITM 代理
cat /tmp/httpfwd.log   # HTTP 转发
```

### xiaozhi + MiMo ASR

```bash
# 安装依赖 + 编译 Rust 原生模块
cd examples/xiaozhi
uv sync
uv run maturin develop

# 下载 VAD + KWS 模型文件
curl -sSfL -o models.zip \
  "https://github.com/idootop/open-xiaoai/releases/download/vad-kws-models/models.zip"
unzip -o models.zip -d xiaozhi/models/ && rm models.zip

# 配置 .env (API Key、assistant 地址等)
cp .env.example .env

# 启动 (需先启动 assistant)
uv run python main.py
```
