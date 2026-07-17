import type { MemoryItem } from "./memory.types";

export interface SearchOptions {
  /**
   * 最多返回多少条
   */
  topK: number;
  /**
   * 结果总长度预算（字）
   */
  maxChars: number;
}

/**
 * 本地打分检索：纯函数、零 IO、<1ms
 *
 * 工具调用只是触发方式，检索本身不产生任何网络开销。
 *
 * 注意：语义这一步不在这里做，这里只负责把两头 join 起来——
 * 写入时抽取器已经把语义压成了 subjects/keywords（还挂上别称），
 * 读取时模型读完整个上下文生成检索词（问"我是谁"它会自己查「用户 名字」，
 * 因为库里说话人一律记成"用户"，这条写在工具说明里教它）。
 * 所以别在这里加同义词表、代词映射之类的硬编码：模型比字符串匹配
 * 清楚得多，规则写进提示词，这里保持又笨又快又可预测。
 *
 * @param query 模型给的检索词，空格分隔
 * @param hint 本轮提问原文，作为辅助线索（模型的检索词可能漏掉上下文里的东西）
 */
export function searchMemories(
  memories: readonly MemoryItem[],
  query: string,
  hint: string,
  options: SearchOptions
): MemoryItem[] {
  const tokens = tokenize(query);
  const text = hint.toLowerCase();
  if (!tokens.length && !text) {
    return [];
  }

  const now = Date.now();
  const scored: { item: MemoryItem; score: number }[] = [];
  for (const item of memories) {
    const subjectHits = item.subjects.filter((e) => matches(e, tokens, text)).length;
    const keywordHits = item.keywords.filter((e) => matches(e, tokens, text)).length;
    // 一个线索都没命中的条目直接排除。否则时近度、importance 这些
    // 与提问无关的加分项会把最近的记忆推上来，检索变成"随便给几条"
    if (!subjectHits && !keywordHits) {
      continue;
    }
    const days = Math.max(0, (now - new Date(item.updatedAt).getTime()) / 86400000);
    const score =
      3.0 * subjectHits +
      1.0 * keywordHits +
      1.0 * Math.exp(-days / 30) +
      0.4 * (item.importance / 5) +
      0.3 * Math.log2(1 + item.hits);
    scored.push({ item, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const picked: MemoryItem[] = [];
  let chars = 0;
  for (const { item } of scored.slice(0, options.topK)) {
    chars += item.content.length;
    if (chars > options.maxChars && picked.length) {
      break;
    }
    picked.push(item);
  }
  return picked;
}

/**
 * 检索结果转成给模型看的紧凑行文本
 */
export function formatMemories(items: readonly MemoryItem[]): string {
  if (!items.length) {
    return "记忆库中没有相关信息。";
  }
  return items
    .map((e) => (e.dueAt ? `- ${e.content}（时间：${e.dueAt}）` : `- ${e.content}`))
    .join("\n");
}

/**
 * 把检索词切成线索
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，、;；]+/)
    .map((e) => e.trim())
    .filter((e) => e);
}

/**
 * 一个 subject/keyword 是否被线索命中
 *
 * 注意：中文没有词边界，这里用双向包含做模糊匹配（"朵朵"命中"朵朵的钢琴课"）。
 * 但单字词（"水""车"）包含匹配的误命中率极高，只允许精确相等。
 */
function matches(term: string, tokens: string[], hint: string): boolean {
  const key = term.toLowerCase();
  if (!key) {
    return false;
  }
  if (key.length < 2) {
    return tokens.includes(key);
  }
  if (tokens.some((e) => (e.length < 2 ? e === key : e.includes(key) || key.includes(e)))) {
    return true;
  }
  return hint.includes(key);
}
