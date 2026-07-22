import type { LLM } from "../llm/llm.service";
import { buildConsolidatePrompt, kConsolidateSystemPrompt } from "../prompts";
import type { Turn } from "../transcript/transcript.types";
import { normalizeOp } from "./ops";
import { type MemoryItem, type MemoryOp } from "./memory.types";

export interface ConsolidateInput {
  /**
   * 全量记忆库
   */
  memories: readonly MemoryItem[];
  /**
   * 保留期内的对话流水
   */
  transcript: Turn[];
  /**
   * 现画像全文
   */
  profile: string;
  /**
   * 画像预算（字）
   */
  profileMaxChars: number;
}

export interface ConsolidateResult {
  ops: MemoryOp[];
  profile: string;
}

export interface ConsolidateOutcome {
  result?: ConsolidateResult;
  error?: string;
}

/**
 * 喂给模型的流水条数上限
 *
 * 注意：14 天的流水可能上千条，全塞进去既超预算又稀释注意力。
 * 挖模式看的是近期的重复，取最近的够用。
 */
export const kMaxTranscript = 200;

/**
 * 睡眠式巩固：把零散记忆消化成理解
 *
 * 对应人脑的睡眠巩固——整理经历、沉淀认知。一次调用做四件事：
 * 去重合并、过期清理、模式挖掘、画像重写。
 *
 * 注意：这四件事本就要纵览全局，拆成四次调用既贵又容易互相打架
 * （比如刚合并完的条目，另一次调用还按旧 id 去改）。
 */
export async function consolidate(
  llm: LLM,
  input: ConsolidateInput
): Promise<ConsolidateOutcome> {
  const prompt = buildConsolidatePrompt({ ...input, maxTranscript: kMaxTranscript });
  let error = "未知错误";
  for (let i = 0; i < 2; i++) {
    let raw = "";
    try {
      const result = await llm.chat([
        { role: "system", content: kConsolidateSystemPrompt },
        { role: "user", content: prompt },
      ]);
      raw = result.content;
    } catch (e) {
      error = `调用失败：${e instanceof Error ? e.message : String(e)}`;
      console.error(`❌ 记忆巩固调用失败（第 ${i + 1} 次）`, e);
      continue;
    }
    const parsed = parseResult(raw, input.profileMaxChars);
    if (parsed) {
      return { result: parsed };
    }
    error = `结果解析失败：${raw.slice(0, 200)}`;
    console.warn(`⚠️ 记忆巩固结果解析失败（第 ${i + 1} 次）：${raw.slice(0, 200)}`);
  }
  return { error };
}

/**
 * 解析巩固结果
 *
 * 注意：巩固会替换整个库和画像，是破坏性的。宁可整批丢弃保持原状，
 * 也不能把半套结果落下去。
 */
function parseResult(raw: string, profileMaxChars: number): ConsolidateResult | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (_) {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const data = parsed as { ops?: unknown; profile?: unknown };
  if (!Array.isArray(data.ops) || typeof data.profile !== "string") {
    return undefined;
  }

  const ops: MemoryOp[] = [];
  for (const item of data.ops) {
    const op = normalizeOp(item);
    if (!op) {
      return undefined;
    }
    ops.push(op);
  }

  return { ops, profile: clamp(data.profile.trim(), profileMaxChars) };
}

/**
 * 画像超预算时截到最后一个完整段落
 *
 * 注意：模型不总听话。硬截一刀可能把句子切成半截，
 * 退到段落边界至少保证读起来是完整的。
 */
function clamp(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const cut = text.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf("\n");
  console.warn(`⚠️ 画像超出预算 ${maxChars} 字（实际 ${text.length}），已截断`);
  return (lastBreak > maxChars * 0.5 ? cut.slice(0, lastBreak) : cut).trim();
}
