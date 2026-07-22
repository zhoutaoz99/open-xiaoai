import { render } from "./template";

const kWeekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

export const kSoulTemplate = render("soul/system-soul-template");

export interface SystemPromptInput {
  soul: string;
  profile?: string;
  tools?: string;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const vars: Record<string, string> = {
    date: day,
    weekday: kWeekdays[now.getDay()],
  };

  vars.soul = input.soul;

  if (input.profile) {
    vars.profile = input.profile;
  }

  if (input.tools) {
    vars.tools = input.tools;
  }

  return render("chat/system-prompt", vars);
}
