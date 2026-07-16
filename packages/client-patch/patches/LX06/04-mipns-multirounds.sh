#!/usr/bin/env bash

set -e

# 开启小爱音箱的连续对话（多轮对话）
#
# 固件里多轮对话的实现本来就是完整的，只是被两处拦住了，这里各改 4 个字节放行：
#
#   1. notify 分发跳转表里 type 6 那一项指向 default 分支，所以 pnshelper 把事件
#      转过来之后，mipns 只会回一句 "unexpected event type: 6!"。
#
#   2. 多轮对话只接受 idle 状态。而 migpt 每轮都要重启 mico_aivs_lab 打断小爱
#      （见 examples/migpt），aivs 一死，"dialog finish" 就永远不会送达 mipns，
#      状态机便卡在 transmitend 回不到 idle，多轮对话每次都被 ignore。
#      固件自己的 "local pre-wakeup, transmitend ---> pre-wakeup!" 说明从
#      transmitend 开一轮新对话是本来就支持的，所以把 transmitend 那一项
#      直接指向 idle 的处理函数。
#
# 打完补丁后，执行下面的命令即可让音箱进入 7 秒的收音窗口（固件写死的时长），
# 期间直接说话即可，无需唤醒词：
#
#   ubus call pnshelper event_notify '{"src":3,"event":4,"detail":"1"}'
#
# 注意：detail 必须非空，否则 pnshelper 会直接返回 -1（invalid null pointer）。

python3 - "usr/bin/mipns-xiaomi" <<'PYTHON'
import struct
import sys
from collections import Counter

BASE = 0x10000  # ARM ELF 加载基址

path = sys.argv[1]
data = bytearray(open(path, "rb").read())


def die(msg):
    print(f"❌ {msg}，取消 patch {path}")
    sys.exit(1)


def only(needle, what):
    """定位唯一的字节串，返回它的 VMA"""
    if data.count(needle) != 1:
        die(f"没有唯一匹配到{what}（找到 {data.count(needle)} 处）")
    return data.find(needle) + BASE


def ldr_ref(text):
    """字符串 -> 字面量池 -> 引用它的 `ldr rX, [pc, #imm]` 指令的 VMA"""
    literal = struct.pack("<I", only(text.encode(), f"日志字符串 {text!r}"))
    pool = only(literal, f"{text!r} 的字面量池条目")
    hits = []
    for off in range(0, len(data) - 4, 4):
        word = struct.unpack_from("<I", data, off)[0]
        # ldr rX, [pc, #imm]，取值时 PC = 指令地址 + 8
        if (word & 0xFFFF0000) == 0xE59F0000 and (off + BASE) + 8 + (word & 0xFFF) == pool:
            hits.append(off + BASE)
    if len(hits) != 1:
        die(f"没有唯一匹配到引用 {text!r} 的指令（找到 {len(hits)} 处）")
    return hits[0]


def tables(pattern):
    """找出所有 `cmp rX, #N` + `ldrls pc, [pc, rX, lsl #2]` 后面跟着的跳转表"""
    out = []
    off = data.find(pattern)
    while off != -1:
        # ldrls 在 pattern+4 处，取值时 PC = (pattern+4)+8
        out.append(off + 12)
        off = data.find(pattern, off + 1)
    return out


def entries(table, n):
    return [struct.unpack_from("<I", data, table + i * 4)[0] for i in range(n)]


# ── 补丁 1：notify 分发跳转表，把 type 6 指回多轮对话的处理函数 ──────────────
#
#   e3500036  cmp   r0, #54
#   979ff100  ldrls pc, [pc, r0, lsl #2]
found = tables(bytes.fromhex("360050e3") + bytes.fromhex("00f19f97"))
if len(found) != 1:
    die(f"没有唯一匹配到 notify 跳转表（找到 {len(found)} 处）")
notify_table = found[0]

# default 分支就是表里出现次数最多的那一项（55 项里有 36 项没实现）
notify_entries = entries(notify_table, 55)
default = Counter(notify_entries).most_common(1)[0][0]

TYPE_MULTIROUNDS = 6
if notify_entries[TYPE_MULTIROUNDS] != default:
    die(f"notify type {TYPE_MULTIROUNDS} 已经指向 0x{notify_entries[TYPE_MULTIROUNDS]:x}，不是 default")

# 日志调用点往前 0x30 是函数入口，校验一下确实是 `ldr r3, [r4]`
handler = ldr_ref("[mipns::notify]:[I]enter notify do multirounds!") - 0x30
if data[handler - BASE : handler - BASE + 4] != bytes.fromhex("003094e5"):
    die(f"0x{handler:x} 处不是预期的 mipns_notify_do_multirounds 入口")

struct.pack_into("<I", data, notify_table + TYPE_MULTIROUNDS * 4, handler)
print(f"  notify 跳转表 0x{notify_table + BASE:x}，type {TYPE_MULTIROUNDS}: 0x{default:x} -> 0x{handler:x}")


# ── 补丁 2：多轮对话状态跳转表，把 transmitend 指向 idle 的处理函数 ──────────
#
#   e3530006  cmp   r3, #6
#   979ff103  ldrls pc, [pc, r3, lsl #2]
#
# 这个模式在 mipns 里有十几处（每个 7 状态的状态机都长这样），所以必须靠
# 各分支的日志字符串来认出哪张才是多轮对话的那张。
STATE_IDLE = 1
STATE_TRANSMITEND = 6

idle_log = ldr_ref("[mipns::worker]:[W]local multirounds, idle ---> preparing!")
tend_log = ldr_ref("[mipns::worker]:[W]local multirounds when transmitend, ignore!")

matched = []
for table in tables(bytes.fromhex("060053e3") + bytes.fromhex("03f19f97")):
    e = entries(table, 7)
    # 两个分支的日志调用点必须分别落在对应表项指向的区块里
    if e[STATE_IDLE] <= idle_log < e[STATE_IDLE + 1] and e[STATE_TRANSMITEND] <= tend_log:
        matched.append((table, e))
if len(matched) != 1:
    die(f"没有唯一认出多轮对话的状态跳转表（找到 {len(matched)} 张）")
state_table, state_entries = matched[0]

if state_entries[STATE_TRANSMITEND] == state_entries[STATE_IDLE]:
    die("状态表里 transmitend 已经指向 idle 的处理函数")

struct.pack_into(
    "<I", data, state_table + STATE_TRANSMITEND * 4, state_entries[STATE_IDLE]
)
print(
    f"  状态跳转表 0x{state_table + BASE:x}，transmitend: "
    f"0x{state_entries[STATE_TRANSMITEND]:x} -> 0x{state_entries[STATE_IDLE]:x}"
)

open(path, "wb").write(data)
PYTHON

echo "patched file usr/bin/mipns-xiaomi"
