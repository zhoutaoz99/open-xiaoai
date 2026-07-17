import type {
  Conversation,
  ExtractionRecord,
  HealthInfo,
  MemoryItem,
  MemorySnapshot,
  SessionSummary,
  SoulDocument,
  StatusInfo,
  Todo,
  Turn,
} from "./api-types";

/**
 * 后端客户端
 *
 * 注意：所有请求都打前台自己的 /api/*，由前台服务端代理补上密钥再转发
 * （见 app/api/[...path]/route.ts）。这里不认识 ASSISTANT_API_KEY，
 * 也不该认识——它一旦进了这个文件就等于进了浏览器。
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new Error(`后端返回了非 JSON 内容（${res.status}）：${text.slice(0, 120)}`);
  }
  if (!res.ok) {
    const message = (data as { message?: string; error?: string })?.message
      ?? (data as { error?: string })?.error
      ?? `请求失败（${res.status}）`;
    throw new Error(Array.isArray(message) ? message.join("；") : String(message));
  }
  return data as T;
}

export const api = {
  health: () => request<HealthInfo>("health"),

  /**
   * 实时状态，给「对话与提炼」页轮询用
   */
  status: () => request<StatusInfo>("status"),

  sessions: () => request<{ sessions: SessionSummary[] }>("sessions"),

  /**
   * 一段段连续对话，最近的在前。侧栏的对话列表用
   */
  conversations: (params: { limit?: number } = {}) =>
    request<{ conversations: Conversation[] }>(`conversations?${query(params)}`),

  turns: (params: {
    sessionId?: string;
    before?: string;
    /**
     * 只取这段对话的轮次
     */
    conversationId?: string;
    limit?: number;
  }) =>
    request<{ turns: Turn[]; hasMore: boolean; nextCursor: string | null }>(
      `turns?${query(params)}`
    ),

  /**
   * 取一批轮次对应的提炼记录
   *
   * 注意：和 turns 分两次请求，是因为它们分属两个业务域，后端不互相依赖
   * （memory 依赖 transcript，反过来就成环了）。前台自己 join 一下就好。
   */
  extractions: (params: {
    turnIds?: string[];
    sessionId?: string;
    kind?: string;
    before?: string;
    limit?: number;
  }) =>
    request<{ extractions: ExtractionRecord[]; hasMore: boolean; nextCursor: string | null }>(
      `extractions?${query({ ...params, turnIds: params.turnIds?.join(",") })}`
    ),

  memories: () =>
    request<{ enabled: boolean; profile: string; memories: MemoryItem[] }>("memories"),

  deleteMemory: (id: string) =>
    request<{ ok: boolean; id: string }>(`memories/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  consolidate: () =>
    request<{ ok: boolean; profile: string; memories: MemoryItem[] }>("memories/consolidate", {
      method: "POST",
    }),

  /**
   * 清除所有数据：对话、记忆、提炼记录、画像。灵魂不动。
   *
   * 注意：不可逆，调用方必须先二次确认。后端清除前会自动拍快照。
   */
  wipe: () => request<{ ok: boolean }>("memories/wipe", { method: "POST" }),

  snapshots: () => request<{ snapshots: MemorySnapshot[] }>("memories/snapshots"),

  /**
   * 待办列表。status 省略则返回全部
   */
  todos: (params: { status?: string } = {}) =>
    request<{ enabled: boolean; todos: Todo[] }>(`todos?${query(params)}`),

  addTodo: (input: { content: string; dueAt?: string | null; remind?: boolean }) =>
    request<Todo>("todos", { method: "POST", body: JSON.stringify(input) }),

  updateTodo: (
    id: string,
    patch: { content?: string; dueAt?: string | null; remind?: boolean; status?: string }
  ) =>
    request<Todo>(`todos/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  completeTodo: (id: string) =>
    request<Todo>(`todos/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "done" }),
    }),

  deleteTodo: (id: string) =>
    request<{ ok: boolean; id: string }>(`todos/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  soul: () => request<SoulDocument>("soul"),
  saveSoul: (text: string) =>
    request<SoulDocument>("soul", { method: "PUT", body: JSON.stringify({ text }) }),

  profile: () => request<SoulDocument>("profile"),
  saveProfile: (text: string) =>
    request<SoulDocument>("profile", { method: "PUT", body: JSON.stringify({ text }) }),
};

function query(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  return search.toString();
}

/**
 * 2026-07-17T19:48:04+08:00 → 07-17 19:48
 */
export function formatTime(iso: string): string {
  return iso.slice(5, 16).replace("T", " ");
}

export function formatDateTime(iso: string | null): string {
  return iso ? iso.slice(0, 19).replace("T", " ") : "—";
}
