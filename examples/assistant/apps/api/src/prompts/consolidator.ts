import type { Turn } from "../transcript/transcript.types";
import { today, type MemoryItem } from "../memory/memory.types";
import { render } from "./template";

export const kConsolidateSystemPrompt = render("consolidate/system-prompt");

export interface ConsolidatePromptInput {
  memories: readonly MemoryItem[];
  transcript: Turn[];
  profile: string;
  profileMaxChars: number;
  maxTranscript: number;
}

export function buildConsolidatePrompt(input: ConsolidatePromptInput): string {
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

  const recent = input.transcript.slice(-input.maxTranscript);
  const transcript = recent.length
    ? recent.map((e) => `[${e.createdAt.slice(0, 16)}] 用户：${e.user}`).join("\n")
    : "（暂无）";

  const profile = input.profile || "（还没有画像）";

  return render("consolidate/user-prompt", {
    today: today(),
    memories,
    transcript,
    profile,
    profileMaxChars: String(input.profileMaxChars),
  });
}
