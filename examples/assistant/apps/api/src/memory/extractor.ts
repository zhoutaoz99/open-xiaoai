import type { LLM } from "../llm/llm.service";
import { ensureSubjects, normalizeOp } from "./ops";
import { today, type MemoryItem, type MemoryOp, type Round } from "./memory.types";

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
  const prompt = buildPrompt(input);
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

const kExtractSystemPrompt = `你是一个长期记忆抽取器，为一台家庭智能音箱工作。
你的任务是从对话记录里挑出值得长期记住的个人信息，输出 JSON 操作数组。
你不和用户对话，只输出 JSON。`;

/**
 * 抽取提示词
 *
 * 注意：防"记忆污染"是这段提示词的重中之重。
 * 记错、记多了比没记住更难收拾——错的记忆会被检索出来，然后被当真。
 */
function buildPrompt(input: ExtractInput): string {
  const related = input.related.length
    ? input.related.map((e) => `${e.id}｜${e.content}（${e.type}）`).join("\n")
    : "（暂无）";
  const subjects = input.subjects.length ? input.subjects.join("、") : "（暂无）";
  const rounds = input.rounds
    .map((e, i) => `第 ${i + 1} 轮\n用户：${e.user}\n助手：${e.assistant}`)
    .join("\n\n");

  const speakerRule = input.speaker
    ? `\n   **本轮声纹识别到说话人是「${input.speaker}」**，所以对话里的"我"指的是${input.speaker}，记成"用户"：\n   用户说"我不吃辣" → {"op":"add","type":"preference","content":"${input.speaker}不吃辣","subjects":["${input.speaker}"],"keywords":["辣","口味","忌口"],"importance":4,"evidence":"我不吃辣"}\n   用户说"朵朵不吃辣" → subjects 才是 ["朵朵"]`
    : `\n   用户说"我不吃辣" → {"op":"add","type":"preference","content":"用户不吃辣","subjects":["用户"],"keywords":["辣","口味","忌口"],"importance":4,"evidence":"我不吃辣"}\n   用户说"朵朵不吃辣" → subjects 才是 ["朵朵"]`;

  return `今天是 ${today()}。

【已有的相关记忆】
${related}

【已有的记忆主体词表】
${subjects}

【本次对话记录】
${rounds}

【输出格式】
一个 JSON 数组，元素是下面三种操作之一：
{"op":"add","type":"fact","content":"朵朵对花粉过敏","subjects":["朵朵"],"keywords":["过敏","花粉"],"importance":4,"evidence":"朵朵一到春天就打喷嚏是花粉过敏"}
{"op":"update","id":"m_x7k2p9","content":"用户喜欢玩英雄联盟","keywords":["英雄联盟","LOL","游戏","打游戏"],"evidence":"用户更正：不是LONELY，是英雄联盟"}
{"op":"delete","id":"m_a3f8q1"}

【规则】
1. **分清这条信息是关于谁的**。对话里的"我"指的是正在说话的那个家人，除非他自报了身份（"我是爸爸"），否则一律记成"用户"：
${speakerRule}
   **绝不能因为词表里已经有某个名字，就把用户说的事安到那个人头上。**
2. 只记稳定的、日后有用的个人信息：家庭成员和称呼、身份、口味偏好、健康状况、重要经历、日程安排。
3. 闲聊、百科问答、天气查询、一次性指令（"放首歌""几点了"）一律不记。**输出 [] 是最常见的正确答案**，不要为了有产出而硬记。
   让助手记待办、设提醒的话（"提醒我三点开会""记一下要买牛奶""别让我忘了交电费"）**也不记**——那是待办功能的事，已经单独存下了，这里再记一条只会和它重复、互相打架。但如果用户是在陈述一个稳定事实（"我每周三固定去健身"），那是习惯/事实，照记。
4. 已有记忆里已经有的，不要重复 add；信息变化或被更正用 update；用户明确要求忘记用 delete。
   **update 只会改你给出的字段，没给的原样保留**。所以凡是跟着 content 一起变的字段都要一并给全——尤其是**更正**（听错了、口误、改口）：旧的 keywords 和 evidence 是照着错的词记下来的，现在它们是错的，必须连着 content 一起换成新的，绝不能只改 content 把错的关键词和原话留在库里。
   例：先记了"用户喜欢玩LONELY"（keywords 有"LONELY"），用户改口说"不是LONELY是英雄联盟"，就要 update 把 content、keywords、evidence 全部换成英雄联盟那套，"LONELY"这个错词一个都不许留。
5. content 用一句话讲清，第三人称，自包含（脱离对话也能看懂），不超过 50 字。
6. subjects 是"这条记忆关于谁/关于什么"。同一个人如果词表里已经有名字了就沿用那个名字（别一会儿"朵朵"一会儿"女儿"）；词表里没有的人或事，直接用对话里的称呼。对齐的意思是统一同一个人的叫法，**不是把新信息塞给已有的名字**。
7. keywords 放补充检索词，**务必带上这个人/这件事的其他叫法**（"朵朵"就该挂上"女儿""闺女"）——日后家人换个说法问起，全靠它才检索得到。
8. type 取值：profile（身份称呼）、preference（偏好）、fact（事实）、event（事件）、task（待办）、habit（习惯）。
9. importance 取值 1-5，越是长期有用越高。
10. 相对时间（明天、下周五）换算成绝对日期；event 和 task 尽量填 dueAt，格式 YYYY-MM-DD。
11. 对话来自语音识别，可能没有标点、有错字、有同音词。拿不准的、像是识别错误的，宁可不记。
12. 只输出 JSON 数组本身，不要任何解释，不要 Markdown 代码块。`;
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
