import { nowISO } from "../memory/memory.types";
import { render } from "./template";

export function userMessageTemplate(
  text: string,
  opts: {
    speaker?: string;
    scheduleLines: string[];
  }
): string {
  return render("chat/user-message", {
    now: nowISO().slice(0, 16).replace("T", " "),
    speaker: opts.speaker ?? "",
    schedule: opts.scheduleLines.join("\n"),
    text,
  });
}
