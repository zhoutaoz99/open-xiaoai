import { today, type MemoryItem, type Round } from "../memory/memory.types";
import { render } from "./template";

export const kExtractSystemPrompt = render("extract/system-prompt");

export interface ExtractPromptInput {
  rounds: Round[];
  related: readonly MemoryItem[];
  subjects: string[];
  speaker?: string;
}

export function buildExtractPrompt(input: ExtractPromptInput): string {
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

  return render("extract/user-prompt", { today: today(), related, subjects, rounds, speakerRule });
}
