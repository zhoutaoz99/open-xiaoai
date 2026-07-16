# OpenXiaoAI Patch

> [!CAUTION]
> 刷机有风险，操作需谨慎。请勿下载使用不明来历的固件！

小爱音箱 Pro 补丁固件制作流程：

- 固件提取（登录小米账号获取 OTA 链接）
- 开启固化 SSH（支持自定义登录密码）
- 禁用系统自动更新（系统更新后需要重新刷机打补丁）
- 添加开机启动脚本 `/data/init.sh`（方便执行一些初始化脚本）
- 开启连续对话（多轮对话，仅 LX06，详见[下方说明](#连续对话多轮对话)）

## 下载固件

你可以直接在 [Github Releases](https://github.com/idootop/open-xiaoai/releases) 页面下载打包好的固件：

- [Xiaomi 智能音箱 Pro v1.58.6](https://github.com/idootop/open-xiaoai/releases/tag/OH2P_1.58.6)
- [小爱音箱 Pro v1.94.13](https://github.com/idootop/open-xiaoai/releases/tag/LX06_1.94.13)

> [!TIP]
> 里面有两个文件，下载 `patched` 那个：
>
> - `xxx_patched.squashfs` 打补丁后的固件
> - `xxx.squashfs` 原版固件（可用来刷回原系统）

> [!NOTE]
> 默认 SSH 登录密码为 `open-xiaoai`，如需修改请自行制作固件。

> [!IMPORTANT]
> 请下载和你当前小爱音箱版本一致的固件，跨版本刷机可能会出现未知错误，导致设备变砖。
> 如果上面没有你的版本，请升级设备固件到最新版本，或者按照下面的教程自行制作固件。

> [!CAUTION]
> 当前支持的最新固件版本为：
>
> - Xiaomi 智能音箱 Pro 👉 [v1.58.6](https://github.com/idootop/open-xiaoai/releases/tag/OH2P_1.58.6)
> - 小爱音箱 Pro 👉 [v1.94.13](https://github.com/idootop/open-xiaoai/releases/tag/LX06_1.94.13)
>
> 更新版本的固件可能存在变化，导致刷机失败，设备变砖，请自行评估风险。

## 制作固件

你可以按照下面的 2 种方法，制作自定义固件。

### 基础配置

修改 `.env.example` 文件里的配置，然后重命名为 `.env`。

```shell
# 你的小米账号/密码
MI_USER=23333333
MI_PASS=xxxxxxxxx

# 你的小爱音箱名称/DID
MI_DID=小爱音箱Pro

# 你的 SSH 登录密码（默认为 open-xiaoai）
SSH_PASSWORD=open-xiaoai
```

### 1. 使用 Docker 打包固件（推荐）

[![Docker Image Version](https://img.shields.io/docker/v/idootop/open-xiaoai?color=%23086DCD&label=docker%20image)](https://hub.docker.com/r/idootop/open-xiaoai)

为了能够正常编译运行该项目，你需要安装以下依赖：

- Docker：https://www.docker.com/get-started/

> [!NOTE]
> Windows 系统请在 [Git Bash](https://git-scm.com/downloads) 终端中运行以下命令。

> [!TIP]
> 如果你是 Apple Silicon 芯片，请先在 Docker Desktop - Settings - General - Virtual Machine Options 中打开 Apple Virtual framework 选项，然后开启 `Use Rosetta for x86_64/amd64 emulation on Apple Silicon`

```shell
# 克隆代码
git clone https://github.com/idootop/open-xiaoai.git

# 进入当前项目根目录
cd packages/client-patch

# 使用 Docker 进行构建
docker run -it --rm \
    --platform linux/amd64 \
    --env-file $(pwd)/.env \
    -v $(pwd)/assets:/app/assets \
    -v $(pwd)/patches:/app/patches \
    idootop/open-xiaoai:latest

# ✅ 打包完成，固件文件已复制到 assets 目录...
# /app/assets/mico_all_92db90ed6_1.88.197/root-patched.squashfs
```

### 2. 本地构建（macOS、Linux）

为了能够正常编译运行该项目，你需要安装以下依赖：

- Python 3.x：https://www.python.org/downloads/
- Node.js 22.x: https://nodejs.org/zh-cn/download

```bash
# 克隆代码
git clone https://github.com/idootop/open-xiaoai.git

# 进入当前项目根目录
cd packages/client-patch

# 安装依赖
npm install

# 打包固件
npm run build

# ✅ 打包成功后，原始固件和补丁固件会保存在 assets 目录下
```

> [!TIP]
> 如果你想要更进一步的定制自己的固件，可以参考 `src/build.sh` 脚本里的构建流程：在提取固件后自行修改固件内的脚本、配置和应用程序，然后重新打包即可。
>
> 想改固件里的**应用程序**（而不只是脚本和配置），请先看 [👉 固件逆向与打补丁指南](./HACKING.md)：里面有组件职责、ubus 事件映射表、mipns 状态机、反汇编定位法、以及不用刷机就能试补丁的 bind mount 循环。

## 连续对话（多轮对话）

`patches/LX06/04-mipns-multirounds.sh` 会开启小爱音箱 Pro 的连续对话：回复播完后音箱自己放提示音、点灯，并保持约 **7 秒**的收音窗口（时长由固件写死），期间直接说话即可，无需再说唤醒词，超时自动退出。

打完补丁后，用下面这条命令让音箱进入连续对话：

```shell
ubus call pnshelper event_notify '{"src":3,"event":4,"detail":"1"}'
```

> [!NOTE]
> `detail` 必须非空，否则 `pnshelper` 直接返回 `-1`（`invalid null pointer!`）。

`examples/migpt` 里配置 `KEEP_AWAKE=true` 即可在每轮回复播完后自动进入连续对话。

<details>
<summary>这个补丁到底改了什么</summary>

固件里多轮对话的实现本来就是**完整**的（`mipns_notify_do_multirounds` → `mipns_speech_event_local_multirounds` + `enable_wakeup_timer`），只是被两处拦住了。补丁各改 4 个字节放行，**全文件只差 8 个字节**。

**① notify 分发跳转表里 `type 6` 指向了 default 分支**

所以 `pnshelper` 把事件转过去之后，只会得到一句：

```
[mipns::notify]:[E]unexpected event type: 6!
```

**② 多轮对话只接受 `idle` 状态**

`transmitend ---> idle` 只有三条路，而且**全部由 aivs 驱动**（`dialog finish` / `asr timeout` / `disconnected`）。`examples/migpt` 每轮都要重启 `mico_aivs_lab` 来打断小爱，aivs 一死，这三个通知谁也不会来，状态机就永远卡在 `transmitend`：

```
[mipns::worker]:[W]local multirounds when transmitend, ignore!
```

所以第二个补丁把状态跳转表里 `transmitend` 那一项直接指向 `idle` 的处理函数。依据是固件自己的行为——`local pre-wakeup, transmitend ---> pre-wakeup!` 说明从 `transmitend` 开一轮新对话本来就是支持的，只是多轮对话这条路径没放行。

> 副作用：日志里会打 `local multirounds, idle ---> preparing!`，即使当时状态是 `transmitend`（复用了 idle 的分支，文案是写死的）。纯文案问题。

脚本里所有位置都是**动态定位**的（模式匹配 + 字符串→字面量池→ldr 引用链）。注意 `cmp r3,#6` 那个状态机模式在 mipns 里有十几处，所以第二个补丁是靠各分支的日志字符串认出正确的那张表的。任何一步对不上都会直接报错退出，不会改错地方。

生效后的日志（音箱上 `tail -f /var/log/messages`）：

```
xaudio_engine: enter set_wakeup_status
xaudio_engine: enable asr = 1
[mipns::worker]:[W]enter speech aivs enable voice wakeup!
[mipns::ani]:[W]animation begin multirounds:7000 2
[mipns::worker]:[W]local multirounds, idle ---> preparing!
[mipns::worker]:[W]aivs prepared, preparing ---> prepared! dialog_id:xxx
```

> [!WARNING]
> 该补丁只在 **LX06 v1.94.13** 上验证过。换固件版本时脚本会因为校验不通过而报错停下，不会默默改错位置。

</details>

<details>
<summary>不想刷机？可以用 bind mount 开启</summary>

`/usr` 是只读的 squashfs，但可以把改好的二进制放在 `/data` 里 bind mount 上去，**不用刷机、重启即还原**：

```shell
# 1. 把打好补丁的 mipns-xiaomi 传到音箱的 /data/mipns-patched
#    （用 curl 传，scp/nc 在这个固件上都不好使）
# 2. 在音箱上执行
/etc/init.d/pns stop        # 运行中的 mipns 占着文件，必须先停
mount -o bind /data/mipns-patched /usr/bin/mipns-xiaomi
/etc/init.d/pns start
```

想让它开机自动生效，写进 `/data/init.sh` 即可。注意两点：

- 要插在**启动 client 那行之前**——那行是阻塞的，写在后面永远不会执行
- 补丁固件的 `/data/init.sh` 默认就是 open-xiaoai 客户端的自启动脚本，别整个覆盖掉

</details>

## 高级选项

### 1. 自定义启动脚本

默认修改后的补丁固件，会将 `/data/init.sh` 文件作为启动脚本，开机时自动运行。如果你需要自定义开机启动脚本，可自行创建和修改该文件。

示例：

```bash
#!/bin/sh

/usr/sbin/tts_play.sh '初始化成功'
```
