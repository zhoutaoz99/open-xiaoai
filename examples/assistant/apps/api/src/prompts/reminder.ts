import { render } from "./template";

export const kReminderRule = render("reminder/system-rule");

export function reminderUserMessage(content: string): string {
  return render("reminder/user-reminder", { content });
}
