import { NextRequest } from "next/server";

/**
 * 后端地址与密钥
 *
 * 注意：都不带 NEXT_PUBLIC_ 前缀，所以只有服务端读得到。
 * 浏览器访问的是前台自己的 /api/*，由这里转发时补上 Authorization——
 * 密钥不进浏览器，这也是为什么前台不直接 fetch 后端。
 */
const kApiUrl = process.env.ASSISTANT_API_URL ?? "http://127.0.0.1:8000";
const kApiKey = process.env.ASSISTANT_API_KEY;

/**
 * 允许前台碰的后端接口
 *
 * 注意：白名单而不是全放开。这个代理会自动补上密钥，等于谁能访问前台、
 * 谁就有后端的完整权限——至少别把 /chat 也捎上：那是音箱走的路，
 * 从浏览器发起会污染会话上下文和记忆。
 */
const kAllowed = [
  "memories",
  "extractions",
  "turns",
  "conversations",
  "sessions",
  "soul",
  "profile",
  "health",
  "status",
];

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (!path?.length || !kAllowed.includes(path[0])) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const url = new URL(`${kApiUrl}/${path.join("/")}`);
  url.search = req.nextUrl.search;

  const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.text();

  try {
    const res = await fetch(url, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        ...(kApiKey ? { Authorization: `Bearer ${kApiKey}` } : {}),
      },
      body,
      cache: "no-store",
    });
    return new Response(res.body, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
    });
  } catch (e) {
    // 后端没起来是最常见的情况，给一句人话，别让页面上只有一个 fetch failed
    return Response.json(
      { error: `连不上后端 ${kApiUrl}：${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as DELETE };
