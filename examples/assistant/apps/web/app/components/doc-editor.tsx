"use client";

import { useEffect, useState } from "react";
import { formatDateTime } from "../lib/api";
import type { SoulDocument } from "../lib/api-types";

interface Props {
  title: string;
  description: string;
  hint: React.ReactNode;
  load: () => Promise<SoulDocument>;
  save: (text: string) => Promise<SoulDocument>;
}

/**
 * Markdown 文档编辑器
 *
 * 灵魂和画像都是 data/ 下实打实的 Markdown 文件——这里改和用编辑器改
 * 是同一份文件，存盘下一句话就生效（后端按 mtime 热加载，不用重启）。
 */
export function DocEditor({ title, description, hint, load, save }: Props) {
  const [doc, setDoc] = useState<SoulDocument>();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();

  useEffect(() => {
    load()
      .then((d) => {
        setDoc(d);
        setText(d.text);
      })
      .catch((e: Error) => setError(e.message));
  }, [load]);

  const dirty = !!doc && text !== doc.text;
  const over = doc?.maxChars !== undefined && text.length > doc.maxChars;

  async function onSave() {
    setSaving(true);
    setNote(undefined);
    setError(undefined);
    try {
      const saved = await save(text);
      setDoc(saved);
      setText(saved.text);
      setNote("已保存，下一句话就生效。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (error && !doc) {
    return <div className="notice error">{error}</div>;
  }
  if (!doc) {
    return <div className="center">加载中…</div>;
  }

  return (
    <>
      <div className="page-head">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>

      <div className="hint">{hint}</div>

      {note ? <div className="notice ok">{note}</div> : null}
      {error ? <div className="notice error">{error}</div> : null}

      <textarea
        className="editor"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        placeholder="还是空的，写点什么…"
      />

      <div className="editor-foot">
        <button className="btn primary" onClick={onSave} disabled={!dirty || saving || !text.trim()}>
          {saving ? "保存中…" : dirty ? "保存" : "已是最新"}
        </button>
        <button className="btn" onClick={() => setText(doc.text)} disabled={!dirty || saving}>
          还原
        </button>
        <span className={over ? "over" : undefined}>
          {text.length} 字
          {doc.maxChars !== undefined ? ` / 预算 ${doc.maxChars}` : ""}
          {over ? "（超了，下次巩固会被截到段落边界）" : ""}
        </span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--mono)" }}>
          {doc.path} · {formatDateTime(doc.updatedAt)}
        </span>
      </div>
    </>
  );
}
