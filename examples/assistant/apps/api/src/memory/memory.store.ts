import {
  nowISO,
  type AppliedOp,
  type MemoryChanges,
  type MemoryItem,
  type MemoryMeta,
  type MemoryOp,
  type MemoryStat,
} from "./memory.types";

export interface ApplyResult {
  stat: MemoryStat;
  /**
   * 每条操作落地后的结果，写进提炼记录给前台看
   */
  applied: AppliedOp[];
  /**
   * 要落到 Postgres 上的改动
   */
  changes: MemoryChanges;
}

/**
 * 记忆库的内存镜像
 *
 * 启动时全量载入，之后读全走内存、写同时落 Postgres。
 * 几千条 = 几百 KB，全内存毫无压力。
 *
 * 为什么不直接查库：检索是应答路径上的一环，而"本地打分 <1ms、零网络"
 * 是这套设计的立身之本（见 search.ts）。为了一次几百微秒的字符串匹配
 * 去跑一趟 SQL，等于把工具调用那一轮省下的时间又还回去。
 *
 * 注意：这个类是纯内存的，零 IO，可独立单测。落库的事归 MemoryRepository，
 * 两者由 MemoryService 串起来。
 */
export class MemoryStore {
  private memories: MemoryItem[] = [];
  private state: MemoryMeta = { lastConsolidatedAt: null, pendingChanges: 0 };

  get size() {
    return this.memories.length;
  }

  get meta(): Readonly<MemoryMeta> {
    return this.state;
  }

  /**
   * 取出全部记忆
   *
   * 注意：返回的是内部数组，调用方只读，不要直接改
   */
  all(): readonly MemoryItem[] {
    return this.memories;
  }

  find(id: string): MemoryItem | undefined {
    return this.memories.find((e) => e.id === id);
  }

  /**
   * 全部 subjects 词表，抽取时给模型对齐用词
   */
  subjects(): string[] {
    return [...new Set(this.memories.flatMap((e) => e.subjects))];
  }

  /**
   * 从库里载入
   */
  load(memories: MemoryItem[], meta: MemoryMeta) {
    this.memories = memories;
    this.state = meta;
  }

  /**
   * 记下巩固已完成，变更计数归零
   */
  markConsolidated() {
    this.state = { lastConsolidatedAt: nowISO(), pendingChanges: 0 };
  }

  /**
   * 套用一批抽取出来的操作
   *
   * 注意：先整体校验再落地。半套用比整批丢弃更糟：
   * 模型的一批操作往往是有关联的（先 update 再 delete），只成一半会让库处于中间状态。
   *
   * @returns 校验不通过返回 undefined，调用方应整批丢弃
   */
  apply(ops: MemoryOp[]): ApplyResult | undefined {
    if (!this.validate(ops)) {
      return undefined;
    }

    const stat: MemoryStat = { added: 0, updated: 0, deleted: 0, merged: 0 };
    const applied: AppliedOp[] = [];
    const changes: MemoryChanges = { upserts: [], deletes: [] };
    const now = nowISO();

    for (const op of ops) {
      if (op.op === "merge") {
        const merged = this.merge(op, now);
        stat.merged++;
        applied.push({ op, id: merged.id, content: merged.content });
        changes.upserts.push(merged);
        // 被并掉的那几条要从库里删掉，留下最早的那条（id 沿用它）
        changes.deletes.push(...op.ids.filter((id) => id !== merged.id));
      } else if (op.op === "add") {
        const item: MemoryItem = {
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
        };
        this.memories.push(item);
        stat.added++;
        applied.push({ op, id: item.id, content: item.content });
        changes.upserts.push(item);
      } else if (op.op === "delete") {
        const item = this.find(op.id);
        this.memories = this.memories.filter((e) => e.id !== op.id);
        stat.deleted++;
        applied.push({ op, id: op.id, content: item?.content });
        changes.deletes.push(op.id);
      } else {
        const item = this.find(op.id)!;
        const { op: _op, id: _id, ...rest } = op;
        Object.assign(item, rest, { updatedAt: now });
        stat.updated++;
        applied.push({ op, id: item.id, content: item.content });
        changes.upserts.push(item);
      }
    }

    this.state.pendingChanges += ops.length;
    return { stat, applied, changes };
  }

  /**
   * 整批校验
   *
   * 注意：要顺着这批操作**模拟 id 的增减**，而不是拿每条 op 去比对初始状态。
   * 模型完全可能吐出 [{delete m_a}, {update m_a}] 这种自相矛盾的批次：
   * 逐条比对初始状态的话两条都合法，等真开始套用，delete 先把它删了，
   * update 再去 find 就是 undefined——一个 TypeError，而且是在库已经被改了
   * 一半之后抛的。那正是「半套用比整批丢弃更糟」说的情况。
   *
   * 这里只跟 id 的存在性，不管字段内容：会引发中途状态不一致的只有增删。
   */
  private validate(ops: MemoryOp[]): boolean {
    const ids = new Set(this.memories.map((e) => e.id));
    for (const op of ops) {
      if (op.op === "add") {
        // add 的 id 是落地时才生成的，这一步没什么可校验的
        continue;
      }
      if (op.op === "merge") {
        // 合并至少要两条，且都得真的还在
        if (op.ids.length < 2 || !op.ids.every((id) => ids.has(id))) {
          console.warn(`⚠️ 合并操作引用了不存在或不足两条的记忆 ${op.ids.join(",")}，整批丢弃`);
          return false;
        }
        // 合并后只剩最早的那条（见 merge()），其余的 id 就此消失
        const survivor = this.survivorOf(op.ids);
        for (const id of op.ids) {
          ids.delete(id);
        }
        ids.add(survivor);
        continue;
      }
      if (!ids.has(op.id)) {
        console.warn(`⚠️ 抽取结果引用了不存在（或已被同批操作删掉）的记忆 ${op.id}，整批丢弃`);
        return false;
      }
      if (op.op === "delete") {
        ids.delete(op.id);
      }
    }
    return true;
  }

  /**
   * 合并后活下来的那条的 id：createdAt 最早的
   *
   * 注意：要和 merge() 的取法完全一致，否则校验时以为还在的 id，
   * 套用完可能已经没了
   */
  private survivorOf(ids: string[]): string {
    return ids
      .map((id) => this.find(id)!)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!.id;
  }

  /**
   * 把说的是同一件事的多条合并成一条
   *
   * 注意：留最早的 createdAt（这事是那时候知道的）、hits 相加（分散在几条上的
   * 使用次数本来就该算作对同一件事的强化），并沿用最早那条的 id——
   * 换个新 id 等于把这条记忆的历史抹掉重来。
   */
  private merge(op: Extract<MemoryOp, { op: "merge" }>, now: string): MemoryItem {
    const items = op.ids
      .map((id) => this.find(id)!)
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
    return merged;
  }

  /**
   * 回写检索命中的强化信号
   *
   * @returns 被改动的条目，交给调用方落库
   */
  markUsed(items: readonly MemoryItem[]): MemoryItem[] {
    const now = nowISO();
    for (const item of items) {
      item.hits++;
      item.lastUsedAt = now;
    }
    return [...items];
  }

  /**
   * 手动删除一条（前台点的删除按钮）
   */
  remove(id: string): MemoryItem | undefined {
    const item = this.find(id);
    if (!item) {
      return undefined;
    }
    this.memories = this.memories.filter((e) => e.id !== id);
    this.state.pendingChanges++;
    return item;
  }

  /**
   * 清空记忆库
   */
  clear() {
    this.memories = [];
    this.state = { lastConsolidatedAt: null, pendingChanges: 0 };
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
