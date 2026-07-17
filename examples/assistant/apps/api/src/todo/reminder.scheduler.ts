import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import type { LLM } from "../llm/llm.service";
import { MEMORY_LLM } from "../llm/llm.types";
import { SoulService } from "../soul/soul.service";
import { NOTIFIER, type Notifier } from "./notifier";
import { TodoService } from "./todo.service";
import { TODO_CONFIG, type Todo, type TodoConfig } from "./todo.types";

/**
 * fire 时给模型的措辞要求
 *
 * 注意：只要一句能直接播报的话。附带 soul 是为了用助手自己的口吻，
 * 但不注入记忆规则/画像那一大套——这是主动提醒，不是一轮对话。
 */
const kReminderRule = `你正在通过家里的音箱，主动提醒主人一件事。请用你自己的口吻，把这件事自然地说出来提醒主人。要求：一句话、口语化、带正常标点、不要 Markdown 或表情、不要任何解释或多余的话，只说提醒本身。`;

/**
 * 主动提醒调度器：分钟级扫描到期待办，用人格措辞后投递到音箱
 *
 * 注意：这是助手第一次拥有不被 /chat 驱动的自主外发行为。投递走 migpt
 * 已有的推送通道（见 notifier.ts）；触发状态全在库里，重启不重放、不漏放。
 */
@Injectable()
export class ReminderScheduler implements OnModuleInit, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  /**
   * 一轮扫描没跑完时，下一次定时到点要跳过——否则慢的 push 会让两轮交叠
   */
  private running = false;

  constructor(
    @Inject(TODO_CONFIG) private config: TodoConfig,
    @Inject(MEMORY_LLM) private llm: LLM,
    @Inject(NOTIFIER) private notifier: Notifier,
    private todo: TodoService,
    private soul: SoulService
  ) {}

  onModuleInit() {
    if (!this.config.enabled) {
      return;
    }
    const interval = Math.max(10, this.config.scanSeconds) * 1000;
    this.timer = setInterval(() => {
      this.tick().catch((e) => console.error("❌ 提醒调度出错", e));
    }, interval);
    this.timer.unref();
    console.log(
      `⏰ 提醒调度已启动：每 ${this.config.scanSeconds} 秒扫一次，` +
        (this.config.pushUrl ? `推送到 ${this.config.pushUrl}` : "未配置推送，到点只打日志")
    );
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const now = new Date();
      const due = await this.todo.dueReminders(now);
      if (!due.length) {
        return;
      }
      const maxLateMs = this.config.maxLateMinutes * 60 * 1000;
      for (const todo of due) {
        const lateMs = now.getTime() - new Date(todo.dueAt!).getTime();
        if (lateMs > maxLateMs) {
          // 迟到太久：标记跳过、不播。防 migpt 断线一段时间恢复后一次性轰炸
          if (await this.todo.markFired(todo.id, now)) {
            console.log(
              `⏭️ 提醒已过期跳过（迟到 ${Math.round(lateMs / 60000)} 分钟）：${todo.content}`
            );
          }
          continue;
        }
        const text = await this.phrase(todo);
        try {
          await this.notifier.push(text);
        } catch (e) {
          // 推送失败（migpt 没起、网络断）：不 markFired，留着下一轮重试
          console.error(`❌ 提醒推送失败，稍后重试：${todo.content}`, e);
          continue;
        }
        // 拿到 202 才标记（见 notifier）：投递已被接受
        if (await this.todo.markFired(todo.id, new Date())) {
          console.log(`🔔 已提醒：${text}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * 用灵魂的口吻把待办措辞成一句提醒
   *
   * 注意：低频、后台，不在应答路径上，所以花一次 LLM 调用无所谓；
   * 调用失败就退回模板句，宁可干巴巴也要把提醒送出去。
   */
  private async phrase(todo: Todo): Promise<string> {
    const fallback = `提醒你，${todo.content}。`;
    try {
      const result = await this.llm.chat([
        { role: "system", content: `${this.soul.soulText()}\n\n${kReminderRule}` },
        { role: "user", content: `要提醒的事：${todo.content}` },
      ]);
      const text = result.content.trim();
      return text || fallback;
    } catch (e) {
      console.error("❌ 提醒措辞失败，用兜底话术", e);
      return fallback;
    }
  }
}
