"use client";

import { useCallback, useEffect, useState } from "react";
import { ExtractionBody, OpRow } from "./components/extraction";
import { api, formatDateTime, formatTime } from "./lib/api";
import type { Conversation, ExtractionRecord, StatusInfo, Turn } from "./lib/api-types";

type Tab = "conversations" | "consolidations";

const kPageSize = 20;

/**
 * 对话列表和右侧对话的轮询间隔：跟着音箱说话实时刷新
 */
const kPollMs = 1000;

/**
 * 一段对话最多拉多少轮
 *
 * 一段对话的轮数封顶在 ASSISTANT_MAX_TURNS（默认 100），但那是会话窗口的
 * 安全阀、不是落库的上限。真有人不间断说满 200 轮的话，这里只显示最近
 * 200 轮，并在顶上说清楚被截了，不装作看到了全部。
 */
const kMaxTurnsPerConversation = 200;

export default function Page() {
  const [tab, setTab] = useState<Tab>("conversations");

  return (
    <>
      <div className="page-head">
        <h1>对话与提炼</h1>
        <p>每一段对话说了什么，以及这轮之后它记住了什么、画像被改成了什么。</p>
      </div>

      <div className="toolbar">
        <button
          className={`btn${tab === "conversations" ? " primary" : ""}`}
          onClick={() => setTab("conversations")}
        >
          对话
        </button>
        <button
          className={`btn${tab === "consolidations" ? " primary" : ""}`}
          onClick={() => setTab("consolidations")}
        >
          画像提炼
        </button>
      </div>

      {tab === "conversations" ? <Conversations /> : <Consolidations />}
    </>
  );
}

/**
 * 左边选对话，右边看这段对话
 */
function Conversations() {
  const [list, setList] = useState<Conversation[]>([]);
  // 存 id 不存对象：列表每秒刷新一遍，对象引用会变，靠 id 才留得住选中项
  const [activeId, setActiveId] = useState<string>();
  const [status, setStatus] = useState<StatusInfo>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let stop = false;

    async function poll() {
      try {
        const [convo, st] = await Promise.all([api.conversations(), api.status()]);
        if (stop) {
          return;
        }
        setList(convo.conversations);
        setStatus(st);
        // 只在还没选过时默认落到最近一段；用户选过了就别抢他的选择
        setActiveId((cur) => cur ?? convo.conversations[0]?.id);
        setError(undefined);
      } catch (e) {
        if (!stop) {
          setError((e as Error).message);
        }
      } finally {
        if (!stop) {
          setLoading(false);
        }
      }
    }

    poll();
    const timer = setInterval(() => {
      // 标签页在后台时不轮询，省得白跑
      if (!document.hidden) {
        poll();
      }
    }, kPollMs);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  // 选中项没了（被清空 / 过期清理掉）就回落到最近一段，别让右边空着
  const active = list.find((c) => c.id === activeId) ?? list[0];

  if (loading && !status) {
    return <div className="center">加载中…</div>;
  }

  return (
    <>
      {status ? <StatusBar status={status} /> : null}
      {error && !list.length ? <div className="notice error">{error}</div> : null}

      {!list.length ? (
        // 有错时只显示上面的错误条，别再画一个"还没有对话记录"误导人
        error ? null : (
          <div className="panel">
            <div className="empty">
              还没有对话记录。
              <br />
              如果确定聊过，检查一下 MEMORY_TRANSCRIPT_DAYS 是不是设成了 0（那样就不落流水）。
            </div>
          </div>
        )
      ) : (
        <div className="convo-layout">
          <aside className="convo-list panel">
            <div className="convo-list-head">
              {list.length} 段对话
              <span title="一次对话 = 一个会话窗口的生命周期：闲置 ASSISTANT_SESSION_TTL_SECONDS 秒后过期，下次开口就是新的一段">
                按会话窗口分
              </span>
            </div>
            {list.map((convo) => (
              <button
                key={convo.id}
                className={`convo-item${active?.id === convo.id ? " active" : ""}`}
                onClick={() => setActiveId(convo.id)}
              >
                <div className="convo-item-title">{convo.title || "（没说话）"}</div>
                <div className="convo-item-meta">
                  <span>{formatTime(convo.startedAt)}</span>
                  <span>{convo.turns} 轮</span>
                </div>
              </button>
            ))}
          </aside>

          {active ? <ConversationPane key={active.id} conversation={active} /> : null}
        </div>
      )}
    </>
  );
}

/**
 * 实时状态条：这会儿在对话、在闲置倒计时、还是在巩固画像
 *
 * 注意：这就是「越用越懂你」那套后台流程的窗口——平时它在日志里一闪而过，
 * 这里让「用户停下来 → 到点巩固 → 画像更新」看得见。
 */
function StatusBar({ status }: { status: StatusInfo }) {
  const { conversation: c, memory: m } = status;

  let tone: string;
  let text: React.ReactNode;

  if (!m.enabled) {
    tone = "idle";
    text = "记忆已关闭，不巩固画像。";
  } else if (m.consolidating) {
    tone = "work";
    text = "正在巩固画像…（把整个库和近期对话过一遍，要几十秒）";
  } else if (c.busy) {
    tone = "live";
    text = "对话进行中，小蜜正在回复…";
  } else if (c.active) {
    tone = "wait";
    text =
      c.idleInSeconds !== null ? (
        <>
          对话闲置中，再过 <strong>{c.idleInSeconds}s</strong> 没有新发言就巩固画像
        </>
      ) : (
        "对话闲置中…"
      );
  } else if (m.pendingChanges > 0) {
    tone = "wait";
    text = (
      <>
        有 <strong>{m.pendingChanges}</strong> 条新记忆等下一次巩固收进画像
      </>
    );
  } else {
    tone = "idle";
    text = m.lastConsolidatedAt ? (
      <>空闲。画像上次巩固于 {formatDateTime(m.lastConsolidatedAt)}</>
    ) : (
      "空闲。画像还没巩固过。"
    );
  }

  return (
    <div className={`status-bar ${tone}`}>
      <span className="status-dot" />
      <span>{text}</span>
    </div>
  );
}

/**
 * 一段对话的全文 + 每轮的提炼记录
 *
 * 注意：轮次和提炼记录分两次请求再在这里 join。后端把它们放在两个业务域里
 * （memory 依赖 transcript，反过来就成环了），所以没有一个现成的联表接口。
 */
function ConversationPane({ conversation }: { conversation: Conversation }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [records, setRecords] = useState<Record<string, ExtractionRecord[]>>({});
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  // 只认 id：header 用的 conversation 对象每秒随列表刷新会换引用，
  // 但只要还是同一段，就不该重新拉一遍、更不该闪一下加载中
  const convId = conversation.id;

  useEffect(() => {
    let stale = false;

    // silent：轮询刷新时不动加载态、不吞掉已有内容，静默把新轮次和
    // 迟到的提炼记录补进来（抽取要十几秒，正是要它自己冒出来）
    async function fetchTurns(silent: boolean) {
      if (!silent) {
        setLoading(true);
        setError(undefined);
      }
      try {
        const page = await api.turns({ conversationId: convId, limit: kMaxTurnsPerConversation });
        const ids = page.turns.map((t) => t.id);
        // 一次把这段所有轮次的提炼记录捞回来，别一轮一个请求
        const found = ids.length
          ? (await api.extractions({ turnIds: ids, kind: "extract", limit: 200 })).extractions
          : [];

        const map: Record<string, ExtractionRecord[]> = {};
        for (const record of found) {
          for (const turnId of record.turnIds) {
            (map[turnId] ??= []).push(record);
          }
        }

        if (stale) {
          return;
        }
        // 接口给的是倒序（前台别处要「最近的在前」），一段对话要从头读起
        setTurns([...page.turns].reverse());
        setRecords(map);
        setTruncated(page.hasMore);
        if (!silent) {
          setError(undefined);
        }
      } catch (e) {
        // 轮询时的偶发失败不打断阅读，只有首次加载失败才报出来
        if (!stale && !silent) {
          setError((e as Error).message);
        }
      } finally {
        if (!stale && !silent) {
          setLoading(false);
        }
      }
    }

    fetchTurns(false);
    const timer = setInterval(() => {
      if (!document.hidden) {
        fetchTurns(true);
      }
    }, kPollMs);

    // 切换对话时：作废在途请求（先发后到会盖掉新选的那段），并停掉这段的轮询
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [convId]);

  return (
    <div className="convo-pane panel">
      <div className="convo-pane-head">
        <div className="convo-pane-title">{conversation.title || "（没说话）"}</div>
        <div className="convo-pane-meta">
          <span>
            {formatTime(conversation.startedAt)} — {formatTime(conversation.endedAt).slice(6)}
          </span>
          <span>{conversation.turns} 轮</span>
          <span className="tag">{conversation.sessionId}</span>
        </div>
      </div>

      {error ? (
        <div className="convo-body">
          <div className="notice error">{error}</div>
        </div>
      ) : loading ? (
        <div className="center">加载中…</div>
      ) : (
        <div className="convo-body">
          {truncated ? (
            <div className="op-note" style={{ textAlign: "center", marginBottom: 8 }}>
              这段对话超过 {kMaxTurnsPerConversation} 轮，只显示最近的部分
            </div>
          ) : null}
          {turns.map((turn) => (
            <TurnBlock key={turn.id} turn={turn} records={records[turn.id] ?? []} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 一轮：用户在右，小蜜在左，底下跟着这轮学到了什么
 */
function TurnBlock({ turn, records }: { turn: Turn; records: ExtractionRecord[] }) {
  return (
    <div className="turn-block">
      <div className="turn-time">{formatTime(turn.createdAt).slice(6)}</div>

      <div className="msg user">
        <div className="msg-body">
          <div className="msg-who">用户</div>
          <div className="msg-text">{turn.user}</div>
        </div>
      </div>

      <div className="msg assistant">
        <div className="msg-body">
          <div className="msg-who">小蜜</div>
          <div className="msg-text">
            {turn.assistant || <em className="faint">（没说话就被抢话了）</em>}
          </div>
        </div>
      </div>

      {records.length ? (
        records.map((record) => (
          <div className="turn-learn" key={record.id}>
            <ExtractionBody record={record} />
          </div>
        ))
      ) : (
        <div className="turn-learn">
          <div className="turn-learn-head">
            <span className="tag">无记录</span>
            <span>抽取还在路上，或者记录已过保留期（MEMORY_EXTRACTION_DAYS）</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 画像提炼：睡眠式巩固干了什么
 */
function Consolidations() {
  const [records, setRecords] = useState<ExtractionRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();

  const load = useCallback(async (before?: string) => {
    setLoading(true);
    try {
      const page = await api.extractions({ kind: "consolidate", before, limit: kPageSize });
      setRecords((prev) => (before ? [...prev, ...page.extractions] : page.extractions));
      setHasMore(page.hasMore);
      setCursor(page.nextCursor);
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function consolidateNow() {
    setBusy(true);
    setNote(undefined);
    setError(undefined);
    try {
      const r = await api.consolidate();
      setNote(r.ok ? "巩固完成，画像已更新。" : "跳过了：没有新记忆，画像不会变（不白烧钱）。");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="hint">
        画像是<strong>习得</strong>的：每轮对话结束（闲置 5 分钟）时炼一版，另外每天凌晨兜底一次。
        它会去重合并、清理过期日程、从流水里挖习惯，再把整个库浓缩成 <strong>profile.md</strong>。
        改写前会自动拍快照，任何一步没通过校验就整体保持原状。
      </div>

      <div className="toolbar">
        <button className="btn" onClick={consolidateNow} disabled={busy}>
          {busy ? "巩固中…（几十秒）" : "立刻巩固一次"}
        </button>
      </div>

      {note ? <div className="notice ok">{note}</div> : null}
      {error ? <div className="notice error">{error}</div> : null}

      {loading && !records.length ? (
        <div className="center">加载中…</div>
      ) : !records.length ? (
        <div className="panel">
          <div className="empty">还没巩固过。攒几轮对话，或者点上面的按钮立刻跑一次。</div>
        </div>
      ) : (
        <div className="panel">
          {records.map((record) => (
            <ConsolidationRow key={record.id} record={record} />
          ))}
          {hasMore ? (
            <button className="load-more" disabled={loading} onClick={() => cursor && load(cursor)}>
              {loading ? "加载中…" : "加载更早的"}
            </button>
          ) : null}
        </div>
      )}
    </>
  );
}

function ConsolidationRow({ record }: { record: ExtractionRecord }) {
  const changed = record.profileBefore !== record.profileAfter;
  return (
    <div className="turn">
      <div className="turn-meta">
        <span>{formatTime(record.createdAt)}</span>
        {record.reason ? <span className="tag">{record.reason}</span> : null}
        {record.status === "failed" ? (
          <span className="tag danger">失败，保持原状</span>
        ) : changed ? (
          <span className="tag ok">画像已重写</span>
        ) : (
          <span className="tag">画像没变</span>
        )}
      </div>

      {record.status === "failed" ? (
        <div className="op-note">{record.error}</div>
      ) : (
        <>
          {record.applied.length ? (
            <div className="turn-learn">
              <div className="turn-learn-head">
                <span className="tag accent">记忆库整理</span>
                {record.stat ? (
                  <span>
                    合并 {record.stat.merged}、新增 {record.stat.added}、更新{" "}
                    {record.stat.updated}、删除 {record.stat.deleted}
                  </span>
                ) : null}
              </div>
              {record.applied.map((applied, i) => (
                <OpRow key={i} applied={applied} />
              ))}
            </div>
          ) : null}

          {changed ? (
            <div className="turn-learn">
              <div className="turn-learn-head">
                <span className="tag accent">画像</span>
                <span>
                  {record.profileBefore?.length ?? 0} 字 → {record.profileAfter?.length ?? 0} 字
                </span>
              </div>
              <div className="bubble">
                <div className="bubble-who">改前</div>
                <div className="bubble-text" style={{ color: "var(--faint)" }}>
                  {record.profileBefore || "（还没有画像）"}
                </div>
              </div>
              <div className="bubble">
                <div className="bubble-who">改后</div>
                <div className="bubble-text">{record.profileAfter}</div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
