import type { LLM } from "../llm/llm.service";
import { buildExtractPrompt, kExtractSystemPrompt } from "../prompts";
import { ensureSubjects, normalizeOp } from "./ops";
import { type MemoryItem, type MemoryOp, type Round } from "./memory.types";

export interface ExtractInput {
  /**
   * 待抽取的轮次
   */
  rounds: Round[];
  /**
   * 与这些轮次可能相关的现有记忆（避免重复 add、支持 update/delete）
   */
  related: readonly MemoryItem[];
  /**
   * 全部 subjects 词表，给模型对齐用词
   */
  subjects: string[];
  /**
   * 声纹识别到的说话人昵称
   *
   * 注意：有值时"我"指的是这个人而不是泛泛的"用户"，
   * 抽取器据此把记忆挂到正确的人头上
   */
  speaker?: string;
}

/**
 * 抽取结果
 *
 * 注意：失败要带上原因——它会进提炼记录给前台看。
 * "这轮为什么没记住"是这套系统最常被问到的问题，
 * 原来只能去翻日志。
 */
export interface ExtractOutcome {
  ops?: MemoryOp[];
  error?: string;
}

/**
 * 从对话里抽取记忆
 *
 * 注意：这是"反思式"后处理，不在应答路径上，所以不用工具调用，
 * 直接要一段 JSON 更简单也更稳。
 */
export async function extract(llm: LLM, input: ExtractInput): Promise<ExtractOutcome> {
  const prompt = buildExtractPrompt(input);
  let error = "未知错误";
  for (let i = 0; i < 2; i++) {
    let raw = "";
    try {
      const result = await llm.chat([
        { role: "system", content: kExtractSystemPrompt },
        { role: "user", content: prompt },
      ]);
      raw = result.content;
    } catch (e) {
      error = `调用失败：${e instanceof Error ? e.message : String(e)}`;
      console.error(`❌ 记忆抽取调用失败（第 ${i + 1} 次）`, e);
      continue;
    }
    const ops = parseOps(raw, input.speaker);
    if (ops) {
      return { ops };
    }
    error = `结果解析失败：${raw.slice(0, 200)}`;
    console.warn(`⚠️ 记忆抽取结果解析失败（第 ${i + 1} 次）：${raw.slice(0, 200)}`);
  }
  return { error };
}

/**
 * 解析模型输出的 JSON 数组
 *
 * 注意：模型经常会包一层 ```json 代码块或者前后加几句话，
 * 所以先把最外层的数组抠出来再解析。
 */
function parseOps(raw: string, speaker?: string): MemoryOp[] | undefined {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (_) {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const ops: MemoryOp[] = [];
  for (const item of parsed) {
    const op = normalizeOp(item);
    // 一条不合法就整批丢弃：模型这次没按格式来，剩下的也不可信
    if (!op) {
      return undefined;
    }
    ops.push(ensureSubjects(op, speaker));
  }
  return ops;
}
