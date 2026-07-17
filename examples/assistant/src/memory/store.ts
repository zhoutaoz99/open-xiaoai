import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  kMemoryTypes,
  nowISO,
  type MemoryFile,
  type MemoryItem,
  type MemoryMeta,
  type MemoryOp,
  type MemoryType,
} from "./types.js";

/**
 * 记忆库文件的版本号，日后改数据结构时用来做迁移
 */
const kVersion = 1;

/**
 * 记忆库：启动全量载入内存，变更即原子写盘
 *
 * 注意：所有写操作都要经 MemoryManager 的单写者队列，本类自身不加锁。
 * 几千条记忆 = 几百 KB，全内存毫无压力。
 */
export class MemoryStore {
  private memories: MemoryItem[] = [];
  private state: MemoryMeta = { lastConsolidatedAt: null, pendingChanges: 0 };

  constructor(private file: string) {}

  get size() {
    return this.memories.length;
  }

  get meta(): Readonly<MemoryMeta> {
    return this.state;
  }

  /**
   * 记下巩固已完成，变更计数归零
   */
  markConsolidated() {
    this.state = { lastConsolidatedAt: nowISO(), pendingChanges: 0 };
  }

  /**
   * 取出全部记忆
   *
   * 注意：返回的是内部数组，调用方只读，不要直接改
   */
  all(): readonly MemoryItem[] {
    return this.memories;
  }

  /**
   * 全部 subjects 词表，抽取时给模型对齐用词
   */
  subjects(): string[] {
    return [...new Set(this.memories.flatMap((e) => e.subjects))];
  }

  /**
   * 载入记忆库
   *
   * 注意：文件损坏时改名备份后从空库启动，绝不让一个坏文件把整个服务卡死
   */
  load() {
    if (!existsSync(this.file)) {
      this.memories = [];
      return;
    }
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as MemoryFile;
      this.memories = (data.memories ?? []).filter((e) => e?.id && e?.content);
      this.state = {
        lastConsolidatedAt: data.meta?.lastConsolidatedAt ?? null,
        pendingChanges: data.meta?.pendingChanges ?? 0,
      };
    } catch (e) {
      const broken = `${this.file}.broken-${Date.now()}`;
      renameSync(this.file, broken);
      this.memories = [];
      console.error(`❌ 记忆库损坏，已备份到 ${broken}，从空库启动`, e);
    }
  }

  /**
   * 套用一批抽取出来的操作
   *
   * 注意：先整体校验再落地。半套用比整批丢弃更糟：
   * 模型的一批操作往往是有关联的（先 update 再 delete），只成一半会让库处于中间状态。
   *
   * @returns 校验不通过返回 undefined，调用方应整批丢弃
   */
  apply(ops: MemoryOp[]): { added: number; updated: number; deleted: number; merged: number } | undefined {
    for (const op of ops) {
      if (op.op === "merge") {
        // 合并至少要两条，且都得真的存在
        const found = op.ids.filter((id) => this.memories.some((e) => e.id === id));
        if (found.length !== op.ids.length || found.length < 2) {
          console.warn(`⚠️ 合并操作引用了不存在或不足两条的记忆 ${op.ids.join(",")}，整批丢弃`);
          return undefined;
        }
      } else if (op.op !== "add" && !this.memories.some((e) => e.id === op.id)) {
        console.warn(`⚠️ 抽取结果引用了不存在的记忆 ${op.id}，整批丢弃`);
        return undefined;
      }
    }

    const stat = { added: 0, updated: 0, deleted: 0, merged: 0 };
    const now = nowISO();
    for (const op of ops) {
      if (op.op === "merge") {
        this.merge(op, now);
        stat.merged++;
      } else if (op.op === "add") {
        this.memories.push({
          id: this.newId(),
          content: op.content,
          type: op.type,
          subjects: op.subjects,
          keywords: op.keywords,
          importance: op.importance,
          dueAt: op.dueAt,
          createdAt: now,
          updatedAt: now,
          hits: 0,
          lastUsedAt: null,
          evidence: op.evidence,
        });
        stat.added++;
      } else if (op.op === "delete") {
        this.memories = this.memories.filter((e) => e.id !== op.id);
        stat.deleted++;
      } else {
        const item = this.memories.find((e) => e.id === op.id)!;
        const { op: _op, id: _id, ...changes } = op;
        Object.assign(item, changes, { updatedAt: now });
        stat.updated++;
      }
    }
    this.state.pendingChanges += ops.length;
    return stat;
  }

  /**
   * 把说的是同一件事的多条合并成一条
   *
   * 注意：留最早的 createdAt（这事是那时候知道的）、hits 相加（分散在几条上的
   * 使用次数本来就该算作对同一件事的强化），并沿用最早那条的 id——
   * 换个新 id 等于把这条记忆的历史抹掉重来。
   */
  private merge(op: Extract<MemoryOp, { op: "merge" }>, now: string) {
    const items = op.ids
      .map((id) => this.memories.find((e) => e.id === id)!)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const first = items[0]!;
    const lastUsed = items
      .map((e) => e.lastUsedAt)
      .filter((e): e is string => !!e)
      .sort()
      .pop();

    const merged: MemoryItem = {
      ...first,
      content: op.content ?? first.content,
      type: op.type ?? first.type,
      subjects: op.subjects ?? [...new Set(items.flatMap((e) => e.subjects))],
      keywords: op.keywords ?? [...new Set(items.flatMap((e) => e.keywords))],
      importance: op.importance ?? Math.max(...items.map((e) => e.importance)),
      dueAt: op.dueAt !== undefined ? op.dueAt : first.dueAt,
      createdAt: first.createdAt,
      updatedAt: now,
      hits: items.reduce((sum, e) => sum + e.hits, 0),
      lastUsedAt: lastUsed ?? null,
    };

    this.memories = this.memories.filter((e) => !op.ids.includes(e.id));
    this.memories.push(merged);
  }

  /**
   * 回写检索命中的强化信号
   */
  markUsed(items: readonly MemoryItem[]) {
    const now = nowISO();
    for (const item of items) {
      item.hits++;
      item.lastUsedAt = now;
    }
  }

  /**
   * 清空记忆库
   */
  clear() {
    this.memories = [];
    this.state = { lastConsolidatedAt: null, pendingChanges: 0 };
  }

  /**
   * 落盘
   *
   * 注意：先写临时文件再 rename。直接写目标文件的话，
   * 写到一半崩溃会留下一个半截的 JSON，下次启动整个库都没了。
   */
  save() {
    const data: MemoryFile = { version: kVersion, memories: this.memories, meta: this.state };
    const tmp = `${this.file}.tmp`;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.file);
  }

  private newId(): string {
    for (;;) {
      const id = `m_${Math.random().toString(36).slice(2, 8)}`;
      if (!this.memories.some((e) => e.id === id)) {
        return id;
      }
    }
  }
}

/**
 * 备份一个文件到同目录的 *-<时间戳>.bak
 *
 * 注意：一句话触发的不可逆操作是大忌，何况语音还会识别错。
 * 清空和巩固改写前都先留一份后悔药。
 */
export function backup(file: string, stamp: string): string | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  const target = join(dirname(file), `${basename(file)}-${stamp}.bak`);
  copyFileSync(file, target);
  return target;
}

/**
 * 删除文件（不存在时静默跳过）
 */
export function remove(file: string) {
  rmSync(file, { force: true });
}

function basename(file: string): string {
  return file.split(/[\\/]/).pop() || file;
}

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
