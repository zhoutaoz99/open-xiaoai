"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, formatDateTime } from "../lib/api";
import type { MemoryItem, MemoryType } from "../lib/api-types";

const kTypeLabel: Record<MemoryType, string> = {
  profile: "身份",
  preference: "偏好",
  fact: "事实",
  event: "事件",
  task: "待办",
  habit: "习惯",
};

type SortKey = "createdAt" | "hits" | "importance";

export default function MemoriesPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState<string>("");
  const [sort, setSort] = useState<SortKey>("createdAt");
  const [deleting, setDeleting] = useState<string>();
  const [confirmingWipe, setConfirmingWipe] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [wipeNote, setWipeNote] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.memories();
      setMemories(r.memories);
      setEnabled(r.enabled);
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

  async function remove(item: MemoryItem) {
    // 删记忆是不可逆的（快照只在清空和巩固时拍），问一句
    if (!confirm(`删除这条记忆？\n\n${item.content}\n\n它不会再被检索到。`)) {
      return;
    }
    setDeleting(item.id);
    try {
      await api.deleteMemory(item.id);
      setMemories((prev) => prev.filter((e) => e.id !== item.id));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(undefined);
    }
  }

  async function wipeAll() {
    setWiping(true);
    setError(undefined);
    try {
      await api.wipe();
      // 库清空了，但对话和画像也一起没了——那两页各自会在下次进入时刷新
      setMemories([]);
      setConfirmingWipe(false);
      setWipeNote(
        "已清除所有对话、记忆和画像。灵魂不受影响。清除前已自动拍快照，真删错了可从数据库的 memory_snapshots 表恢复。"
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWiping(false);
    }
  }

  const shown = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    return memories
      .filter((e) => !type || e.type === type)
      .filter(
        (e) =>
          !key ||
          e.content.toLowerCase().includes(key) ||
          e.subjects.some((s) => s.toLowerCase().includes(key)) ||
          e.keywords.some((k) => k.toLowerCase().includes(key))
      )
      .slice()
      .sort((a, b) =>
        sort === "createdAt"
          ? b.createdAt.localeCompare(a.createdAt)
          : b[sort] - a[sort]
      );
  }, [memories, keyword, type, sort]);

  return (
    <>
      <div className="page-head">
        <h1>记忆库</h1>
        <p>
          它记住的所有明细。检索时按本地打分排序，命中次数（hits）是强化信号——
          被查得越多，日后排得越靠前。
        </p>
      </div>

      {!enabled ? (
        <div className="notice error">记忆已关闭（MEMORY_ENABLED=false），这里是空的。</div>
      ) : null}
      {error ? <div className="notice error">{error}</div> : null}

      <div className="toolbar">
        <input
          type="text"
          placeholder="搜内容、主体、关键词…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{ minWidth: 220 }}
        />
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">全部类型</option>
          {Object.entries(kTypeLabel).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="createdAt">按记录时间</option>
          <option value="hits">按命中次数</option>
          <option value="importance">按重要度</option>
        </select>
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? "刷新中…" : "刷新"}
        </button>
        <span style={{ color: "var(--faint)", fontSize: 12 }}>
          共 {memories.length} 条{shown.length !== memories.length ? `，筛出 ${shown.length} 条` : ""}
        </span>
      </div>

      {loading && !memories.length ? (
        <div className="center">加载中…</div>
      ) : !shown.length ? (
        <div className="panel">
          <div className="empty">
            {memories.length ? "没有匹配的记忆。" : "记忆库还是空的。聊几句它就开始记了。"}
          </div>
        </div>
      ) : (
        <div className="panel" style={{ overflowX: "auto" }}>
          <table className="mem-table">
            <thead>
              <tr>
                <th>记忆</th>
                <th>类型</th>
                <th>主体 / 关键词</th>
                <th className="nowrap">重要度</th>
                <th className="nowrap">命中</th>
                <th className="nowrap">记于</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => (
                <tr key={item.id}>
                  <td style={{ minWidth: 240 }}>
                    <div className="mem-content">{item.content}</div>
                    {item.dueAt ? (
                      <div className="mem-evidence">📅 {item.dueAt}</div>
                    ) : null}
                    {item.evidence ? (
                      <div className="mem-evidence">原话：{item.evidence}</div>
                    ) : null}
                  </td>
                  <td>
                    <span className="tag">{kTypeLabel[item.type] ?? item.type}</span>
                  </td>
                  <td style={{ minWidth: 160 }}>
                    <div className="chips">
                      {item.subjects.map((s) => (
                        <span className="tag accent" key={s}>
                          {s}
                        </span>
                      ))}
                      {item.keywords.map((k) => (
                        <span className="tag" key={k}>
                          {k}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="num nowrap">{item.importance}/5</td>
                  <td className="num nowrap" title={`最近命中：${formatDateTime(item.lastUsedAt)}`}>
                    {item.hits}
                  </td>
                  <td className="num nowrap">{item.createdAt.slice(0, 10)}</td>
                  <td>
                    <button
                      className="btn danger"
                      onClick={() => remove(item)}
                      disabled={deleting === item.id}
                    >
                      {deleting === item.id ? "删除中…" : "删除"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="danger-zone">
        <div className="danger-zone-head">清除所有数据</div>
        <p className="danger-zone-desc">
          清除<strong>对话记录、记忆库、提炼记录和画像</strong>，也就是它对这个家的全部理解。
          <strong>灵魂（soul.md）不受影响</strong>——人格是设定的，不随记忆被清。
          <br />
          不可逆，但清除前会自动拍一张快照存进数据库，真删错了还能从 memory_snapshots 恢复。
        </p>

        {wipeNote ? <div className="notice ok">{wipeNote}</div> : null}

        {confirmingWipe ? (
          <div className="danger-confirm">
            <span>确定清除全部对话、记忆和画像？此操作不可撤销。</span>
            <button className="btn danger-solid" onClick={wipeAll} disabled={wiping}>
              {wiping ? "清除中…" : "确认清除"}
            </button>
            <button className="btn" onClick={() => setConfirmingWipe(false)} disabled={wiping}>
              取消
            </button>
          </div>
        ) : (
          <button
            className="btn danger-solid"
            disabled={!enabled}
            title={enabled ? undefined : "记忆已关闭，没有数据可清"}
            onClick={() => {
              setWipeNote(undefined);
              setConfirmingWipe(true);
            }}
          >
            清除所有数据
          </button>
        )}
      </div>
    </>
  );
}
