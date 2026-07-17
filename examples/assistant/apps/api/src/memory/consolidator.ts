import type { LLM } from "../llm/llm.service";
import type { Turn } from "../transcript/transcript.types";
import { normalizeOp } from "./ops";
import { today, type MemoryItem, type MemoryOp } from "./memory.types";

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
  const prompt = buildPrompt(input);
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

const kConsolidateSystemPrompt = `你是一台家庭智能音箱的记忆巩固器，在夜里安静地整理这个家的记忆。
你要做的是"消化"：把零散的记录整理干净，并从中提炼出对这家人的理解。
你不和用户对话，只输出 JSON。`;

function buildPrompt(input: ConsolidateInput): string {
  const memories = input.memories.length
    ? input.memories
        .map(
          (e) =>
            `${e.id}｜${e.content}｜type=${e.type}｜主体=${e.subjects.join("/")}` +
            `｜importance=${e.importance}｜命中=${e.hits}｜记于=${e.createdAt.slice(0, 10)}` +
            (e.dueAt ? `｜时间=${e.dueAt}` : "")
        )
        .join("\n")
    : "（暂无）";

  // 只给最近的：挖模式看的是近期重复，太久远的既超预算又没参考价值
  const recent = input.transcript.slice(-kMaxTranscript);
  const transcript = recent.length
    ? recent.map((e) => `[${e.createdAt.slice(0, 16)}] 用户：${e.user}`).join("\n")
    : "（暂无）";

  const profile = input.profile || "（还没有画像）";

  return `今天是 ${today()}。

【当前记忆库】
${memories}

【近期对话流水（只列用户说的话）】
${transcript}

【当前画像】
${profile}

【你要做四件事】

一、去重合并：说的是同一件事的多条，合并成一条。
{"op":"merge","ids":["m_a","m_b"],"content":"合并后的一句话"}

二、过期清理：只清"已经不成立"的，绝不清"很少用到"的。
- 已经过去的 event/task：有留存价值的改写成事实（去掉 dueAt）；纯粹一次性、过去了就没意义的才删。
  {"op":"update","id":"m_d","content":"朵朵在 2026 年 6 月参加过钢琴考级","type":"fact","dueAt":null}
  {"op":"delete","id":"m_c"}
- 被新信息推翻、已经不成立的，删掉。
- **不许因为"很少用到"就删**：车牌号、宽带账号、证件号、某次旅行这类明细，可能一年才问一次，
  但问起来的时候必须还在。命中次数是 0 只说明还没人问过，**不说明没价值**——
  库可以无限长，装这些长尾正是它存在的意义（常用的那些自然会被巩固进画像）。
- **拿不准的一律留着**。留着的代价只是几十个字，删错了就再也找不回来。

三、模式挖掘：从流水里找**重复出现的规律**，归纳成 habit 条目。
{"op":"add","type":"habit","content":"用户每天早上七点左右问天气","subjects":["用户"],"keywords":["天气","早上","习惯"],"importance":3}
- 单次行为不是习惯，至少重复三次以上、跨越多天才算。
- 记忆库里已经有的习惯不要重复添加。
- 挖不出来就别硬挖，这一项交白卷是常态。

四、重写画像：把整个库浓缩成对这家人的理解。

画像会**跟着每一句话一起发给你**，是你开口前就知道的背景；库里的明细则要现查才能拿到。
所以取舍标准只有一条——**不问也该知道的，才进画像**：

- 进画像：怎么称呼家里人、家里有谁、长期口味、作息规律、近几天的安排、近况。
  这些几乎每句话都可能用上，让它常驻能省掉一次检索。
- **不进画像**：问到才需要的明细（车牌号、身份证号、某次经历的具体日期、一次性的事）。
  这些留在库里，用户问起时我会检索给你。抄进画像只会挤掉真正常用的东西。
- 拿不准就问自己：家人下一句话就用得上它吗？用不上就别占这 ${input.profileMaxChars} 字。

写法要求：
- 固定分节：# 称呼与家庭、# 口味与偏好、# 习惯与作息、# 近期安排、# 近况。没内容的节直接省略。
- **不超过 ${input.profileMaxChars} 字**。这是给下一次对话当背景的印象，不是库的目录。
- **归纳，不要罗列**：库里"用户不吃辣""朵朵不吃辣"两条，画像写"全家都不吃辣"一句就够。
  画像不是把库抄一遍——那样它就没有存在的意义了。
- "# 近期安排"只写今天及以后、还没发生的事（来自带时间的条目）。
- 写成给人看的自然段落，不要罗列 id。
- **当前画像里的内容，只要没有被新证据推翻，必须原样保留**——里面可能有主人亲手写的话，你无权替他删掉。

【输出格式】
一个 JSON 对象，两个字段：
{"ops":[...],"profile":"# 称呼与家庭\\n……"}
- ops：上面一到三的操作数组，没有就给 []。
- profile：第四步重写后的画像全文。库和流水都空时给 ""。
- 只输出这个 JSON 对象本身，不要任何解释，不要 Markdown 代码块。`;
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
