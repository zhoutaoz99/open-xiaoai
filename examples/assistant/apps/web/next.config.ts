import type { NextConfig } from "next";
import { resolve } from "node:path";

const config: NextConfig = {
  // monorepo 必需：不指定的话 turbopack 会往上找到 open-xiaoai 仓库根，
  // 把整个仓库（含 rust 代码和别的 example）当成项目根
  turbopack: {
    root: resolve(__dirname, "../.."),
  },
  // Next 16 的 dev server 默认只认 localhost，用 127.0.0.1 或局域网 IP 打开时
  // 会把 /_next/* 这些开发资源拦掉——页面能出来，但 React 不会 hydrate，
  // 于是整页永远停在"加载中…"，控制台里也只有一条不起眼的告警。
  // 这个服务本来就是给家里内网用的，把常见的几个来源放行。
  allowedDevOrigins: ["127.0.0.1", "localhost", "0.0.0.0"],
  logging: {
    // 「对话与提炼」页每秒轮询 /api/*（对话列表 + 状态 + 当前对话 + 提炼记录），
    // dev server 默认每个请求打一行，一秒四行直接刷屏。而 /api/* 只是前台
    // 代理往后端转发的一跳，后端那边该记的自己都记了，这一层日志纯属重复。
    // 静默掉它，页面加载、编译错误这些照常打。
    incomingRequests: {
      ignore: [/^\/api\//],
    },
  },
};

export default config;
