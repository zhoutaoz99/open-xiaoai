import { kMemoryTypes, type MemoryOp, type MemoryType } from "./memory.types";

/**
 * 校验并规整大模型输出的一条操作
 *
 * 注意：这是不可信输入，字段缺失、类型不对、取值越界都要挡住
 */
export function normalizeOp(raw: unknown): MemoryOp | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const op = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const list = (v: unknown) =>
    Array.isArray(v) ? v.map(str).filter((e): e is string => !!e) : undefined;
  const type = kMemoryTypes.includes(op.type as never) ? (op.type as MemoryType) : undefined;
  const importance =
    typeof op.importance === "number" && op.importance >= 1 && op.importance <= 5
      ? Math.round(op.importance)
      : undefined;
  const dueAt = str(op.dueAt) ?? null;

  if (op.op === "add") {
    const content = str(op.content);
    if (!content) {
      return undefined;
    }
    return {
      op: "add",
      content,
      type: type ?? "fact",
      subjects: list(op.subjects) ?? [],
      keywords: list(op.keywords) ?? [],
      importance: importance ?? 3,
      dueAt,
      evidence: str(op.evidence),
    };
  }

  if (op.op === "merge") {
    const ids = list(op.ids);
    if (!ids || ids.length < 2) {
      return undefined;
    }
    const merge: Extract<MemoryOp, { op: "merge" }> = { op: "merge", ids };
    const content = str(op.content);
    if (content) merge.content = content;
    if (type) merge.type = type;
    if (list(op.subjects)?.length) merge.subjects = list(op.subjects);
    if (list(op.keywords)?.length) merge.keywords = list(op.keywords);
    if (importance) merge.importance = importance;
    if (op.dueAt !== undefined) merge.dueAt = dueAt;
    return merge;
  }

  const id = str(op.id);
  if (!id) {
    return undefined;
  }
  if (op.op === "delete") {
    return { op: "delete", id };
  }
  if (op.op === "update") {
    const changes: Extract<MemoryOp, { op: "update" }> = { op: "update", id };
    const content = str(op.content);
    if (content) changes.content = content;
    if (type) changes.type = type;
    if (list(op.subjects)?.length) changes.subjects = list(op.subjects);
    if (list(op.keywords)?.length) changes.keywords = list(op.keywords);
    if (importance) changes.importance = importance;
    if (op.dueAt !== undefined) changes.dueAt = dueAt;
    if (str(op.evidence)) changes.evidence = str(op.evidence);
    return changes;
  }
  return undefined;
}

/**
 * 记忆条目里没有 subjects 的话检索不到，补一个兜底
 */
export function ensureSubjects(op: MemoryOp): MemoryOp {
  if (op.op === "add" && !op.subjects.length && !op.keywords.length) {
    return { ...op, subjects: ["用户"] };
  }
  return op;
}
