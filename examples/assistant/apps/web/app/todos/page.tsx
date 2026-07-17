"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, formatTime } from "../lib/api";
import type { Todo, TodoStatus } from "../lib/api-types";

const kStatusLabel: Record<TodoStatus, string> = {
  pending: "待办",
  done: "已完成",
  cancelled: "已取消",
};

export default function TodosPage() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<string>("");
  const [busy, setBusy] = useState<string>();

  // 新增表单
  const [content, setContent] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [remind, setRemind] = useState(true);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.todos();
      setTodos(r.todos);
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
    // 待办变化慢，不用学首页那 1 秒——8 秒够语音新建的待办自己冒出来
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [load]);

  async function add() {
    const text = content.trim();
    if (!text) {
      return;
    }
    setAdding(true);
    setError(undefined);
    try {
      // datetime-local 给的是 "2026-07-18T15:00"（本地、无偏移），
      // 后端会补上默认秒和本地时区
      await api.addTodo({ content: text, dueAt: dueAt || null, remind });
      setContent("");
      setDueAt("");
      setRemind(true);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function complete(todo: Todo) {
    setBusy(todo.id);
    try {
      await api.completeTodo(todo.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function remove(todo: Todo) {
    if (!confirm(`删除这条待办？\n\n${todo.content}`)) {
      return;
    }
    setBusy(todo.id);
    try {
      await api.deleteTodo(todo.id);
      setTodos((prev) => prev.filter((e) => e.id !== todo.id));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  const shown = useMemo(
    () => todos.filter((t) => !filter || t.status === filter),
    [todos, filter]
  );
  const pendingCount = useMemo(
    () => todos.filter((t) => t.status === "pending").length,
    [todos]
  );

  return (
    <>
      <div className="page-head">
        <h1>待办</h1>
        <p>
          它替你记着的事。带时间又开了提醒的，到点会通过音箱主动开口——
          说「提醒我三点开会」它就记一条，也可以在这儿手动加。
        </p>
      </div>

      {!enabled ? (
        <div className="notice error">待办已关闭（TODO_ENABLED=false），这里是空的。</div>
      ) : null}
      {error ? <div className="notice error">{error}</div> : null}

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="toolbar" style={{ flexWrap: "wrap" }}>
          <input
            type="text"
            placeholder="要做/要提醒的事，如：三点开会"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            style={{ minWidth: 240, flex: 1 }}
          />
          <input
            type="datetime-local"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            title="到期时刻（不填就只是一条清单项，不会主动提醒）"
          />
          <label
            style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--faint)", fontSize: 13 }}
            title="到点通过音箱主动播报"
          >
            <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
            到点提醒
          </label>
          <button className="btn primary" onClick={add} disabled={adding || !content.trim() || !enabled}>
            {adding ? "添加中…" : "添加"}
          </button>
        </div>
        {remind && !dueAt ? (
          <div className="hint" style={{ marginTop: 8 }}>
            开了提醒但没填时间——没有时刻就不会主动播报，只是记一条清单。
          </div>
        ) : null}
      </div>

      <div className="toolbar">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">全部</option>
          {(Object.keys(kStatusLabel) as TodoStatus[]).map((s) => (
            <option key={s} value={s}>
              {kStatusLabel[s]}
            </option>
          ))}
        </select>
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? "刷新中…" : "刷新"}
        </button>
        <span style={{ color: "var(--faint)", fontSize: 12 }}>
          待办 {pendingCount} 条{shown.length !== todos.length ? `，筛出 ${shown.length} 条` : `，共 ${todos.length} 条`}
        </span>
      </div>

      {loading && !todos.length ? (
        <div className="center">加载中…</div>
      ) : !shown.length ? (
        <div className="panel">
          <div className="empty">
            {todos.length ? "没有匹配的待办。" : "还没有待办。说一句「提醒我…」，或在上面手动加一条。"}
          </div>
        </div>
      ) : (
        <div className="panel" style={{ overflowX: "auto" }}>
          <table className="mem-table">
            <thead>
              <tr>
                <th>待办</th>
                <th className="nowrap">时间</th>
                <th className="nowrap">提醒</th>
                <th className="nowrap">状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((todo) => (
                <tr key={todo.id} style={{ opacity: todo.status === "pending" ? 1 : 0.55 }}>
                  <td style={{ minWidth: 240 }}>
                    <div className="mem-content">{todo.content}</div>
                    <div className="mem-evidence">
                      {todo.id}
                      {todo.source === "web" ? " · 手动添加" : ""}
                    </div>
                  </td>
                  <td className="num nowrap">{todo.dueAt ? formatTime(todo.dueAt) : "—"}</td>
                  <td className="nowrap">
                    {todo.remind ? (
                      <span className="tag accent">🔔 到点提醒</span>
                    ) : (
                      <span className="tag">清单</span>
                    )}
                    {todo.firedAt ? (
                      <div className="mem-evidence">已提醒 {formatTime(todo.firedAt)}</div>
                    ) : null}
                  </td>
                  <td className="nowrap">
                    <span className="tag">{kStatusLabel[todo.status]}</span>
                  </td>
                  <td className="nowrap">
                    {todo.status === "pending" ? (
                      <button
                        className="btn"
                        onClick={() => complete(todo)}
                        disabled={busy === todo.id}
                        style={{ marginRight: 6 }}
                      >
                        {busy === todo.id ? "…" : "完成"}
                      </button>
                    ) : null}
                    <button
                      className="btn danger"
                      onClick={() => remove(todo)}
                      disabled={busy === todo.id}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
