import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { LLM, type LLMConfig, type ToolCall } from "../llm.js";
import { consolidate } from "./consolidator.js";
import { extract } from "./extractor.js";
import { formatMemories, searchMemories } from "./search.js";
import { backup, MemoryStore, remove } from "./store.js";
import { Transcript } from "./transcript.js";
import { today, type MemoryItem, type Round } from "./types.js";

export interface MemoryConfig {
  /**
   * 记忆总开关，关闭后回到纯内存版
   */
  enabled: boolean;
  /**
   * 记忆库文件
   */
  file: string;
  /**
   * 画像文件（本类只负责备份和清空，读取和注入是 soul.ts 的事）
   */
  profileFile: string;
  /**
   * 对话流水文件
   */
  transcriptFile: string;
  /**
   * 流水保留天数，0 表示不落流水
   */
  transcriptDays: number;
  /**
   * 单次检索最多返回多少条
   */
  recallTopK: number;
  /**
   * 单次检索结果的长度预算（字）
   */
  recallMaxChars: number;
  /**
   * 每个请求最多允许几轮带检索的模型往返
   *
   * 注意：数的是往返轮次，不是工具调用条数——模型可能在一轮里并行查好几个词
   */
  searchMaxCalls: number;
  /**
   * 记忆检索的传输方式
   *
   * - tools：标准 function calling
   * - marker：文本标记协议，给流式工具调用不稳的服务商兜底，语义完全一样
   */
  recallTransport: "tools" | "marker";
  /**
   * 检索时先播的填补话术，置空关闭
   */
  searchFiller?: string;
  /**
   * 画像预算（字）
   */
  profileMaxChars: number;
  /**
   * 每天几点兜底巩固一次，形如 03:00（本地时间）
   *
   * 注意：正常情况下画像在每轮对话结束时就炼好了，这一趟只收拾
   * 那些等不到"对话结束"的残局（比如聊到一半重启了）。没有新记忆就空转跳过。
   */
  consolidateAt: string;
  /**
   * 命中这些关键词时清空长期记忆（精确匹配）
   */
  wipeKeywords: string[];
  /**
   * 清空长期记忆后的回复话术
   */
  wipeText: string;
  /**
   * 抽取专用的大模型配置，可以用便宜的模型
   */
  openai: LLMConfig;
}

/**
 * 一天
 */
const kDay = 24 * 60 * 60 * 1000;

/**
 * 算出下一个 HH:MM（本地时间）的时间戳，已经过了就算明天的
 */
function nextTime(hhmm: string): number {
  const [h = 3, m = 0] = hhmm.split(":").map((e) => Number(e.trim()));
  const next = new Date();
  next.setHours(Number.isFinite(h) ? h : 3, Number.isFinite(m) ? m : 0, 0, 0);
  if (next.getTime() <= Date.now()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

/**
 * 记忆库不超过这个条数时，抽取直接把整个库给模型看，详见 related()
 */
const kFullContextMax = 80;

/**
 * 临期日程往后看几天
 */
const kUpcomingDays = 3;

/**
 * 临期日程最多注入几条
 *
 * 注意：这是唯一保留的自动注入，条目少而具体才不构成注意力污染
 */
const kUpcomingMax = 3;

const kSearchTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_memory",
    description:
      "检索你的长期记忆库（关于这个家庭的身份、事实、偏好、事件）。当需要用户或家人的具体信息而当前上下文里没有时，先检索再回答。" +
      "用户问他自己的事（我是谁、我叫什么、我的车牌号是多少）也要用它检索。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "空格分隔的检索词：人名、事物、主题。问用户自己的事就用「用户」当人称，比如：用户 名字；问家人就用名字，比如：朵朵 过敏",
        },
      },
      required: ["query"],
    },
  },
};

/**
 * 长期记忆的对外唯一门面
 *
 * 注意：所有写操作都走同一条 promise 链串行执行（单写者队列），
 * 与 SessionStore.lock() 相互独立。
 */
export class MemoryManager {
  private llm: LLM;
  private store: MemoryStore;
  private transcript: Transcript;
  /**
   * 单写者队列
   */
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * 等待抽取的轮次
   */
  private pending: Round[] = [];
  private draining = false;
  private consolidating = false;
  private timer?: NodeJS.Timeout;
  private consolidateTimer?: NodeJS.Timeout;

  constructor(private config: MemoryConfig) {
    this.llm = new LLM(config.openai);
    this.store = new MemoryStore(config.file);
    this.transcript = new Transcript(config.transcriptFile, config.transcriptDays);
  }

  get enabled() {
    return this.config.enabled;
  }

  get size() {
    return this.store.size;
  }

  async start() {
    if (!this.enabled) {
      return;
    }
    this.store.load();
    await this.write(() => this.transcript.prune());
    // 流水没人清就会一直涨。定时巩固（阶段二）会顺手做这件事，
    // 在那之前先自己扫，否则一个常年不重启的实例文件会越滚越大
    this.timer = setInterval(() => {
      this.write(() => this.transcript.prune()).catch((e) =>
        console.error("❌ 清理对话流水失败", e)
      );
    }, kDay);
    this.timer.unref();

    // 睡眠式巩固：低频、后台、不赶时间。
    // 注意：这里只是"多久看一眼"，到没到点由 isDue() 拿 lastConsolidatedAt 算。
    // 直接把 setInterval 设成 24 小时是错的——那是按进程运行时长计时，
    // 每天重启一次服务，这个点就永远等不到，画像永远炼不出来。
    this.scheduleDaily();
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.consolidateTimer);
    this.timer = undefined;
    this.consolidateTimer = undefined;
  }

  /**
   * 排下一次每日兜底巩固
   *
   * 注意：每次算到"下一个 03:00"再定一次闹钟，而不是 setInterval(24 小时)。
   * 后者是按进程运行时长计时的：每天重启一次服务，那个点就永远等不到；
   * 而且它会慢慢漂，跟"凌晨三点"越差越远。
   */
  private scheduleDaily() {
    const delay = Math.max(1000, nextTime(this.config.consolidateAt) - Date.now());
    this.consolidateTimer = setTimeout(() => {
      this.maybeConsolidate("每日");
      this.scheduleDaily();
    }, delay);
    this.consolidateTimer.unref();
  }

  /**
   * 未来几天内的日程（前瞻记忆）
   *
   * 注意：这是唯一保留的自动注入。推送型记忆等不来检索——用户问"今天有什么安排"
   * 模型会查，但"明天有钢琴课"应该在聊到出游时不查自知。
   */
  upcoming(): MemoryItem[] {
    if (!this.enabled) {
      return [];
    }
    const from = today();
    const to = today(new Date(Date.now() + kUpcomingDays * kDay));
    return this.store
      .all()
      .filter((e) => (e.type === "event" || e.type === "task") && e.dueAt)
      // 只比日期部分，按字符串比。ISO 日期天然可比，
      // 而 new Date("2026-07-18") 会按 UTC 解析，东八区就会差出一天
      .filter((e) => {
        const due = e.dueAt!.slice(0, 10);
        return due >= from && due <= to;
      })
      .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))
      .slice(0, kUpcomingMax);
  }

  /**
   * 用户不说话了，一轮对话结束——巩固最好的时机
   *
   * 注意：这才是真正的"睡眠"。定时器是盲的，可能在用户说到一半时触发；
   * 而这里人已经走开了，跑一次几十秒的全库调用没人等着。
   */
  onIdle() {
    this.maybeConsolidate("对话结束");
  }

  /**
   * 立刻巩固一次，不管有没有新记忆（给 HTTP 接口和排查用）
   */
  async consolidateNow(): Promise<boolean> {
    if (!this.enabled || this.consolidating) {
      return false;
    }
    this.consolidating = true;
    try {
      return await this.write(() => this.runConsolidation("手动", true));
    } finally {
      this.consolidating = false;
    }
  }

  /**
   * 随请求声明的工具，记忆关闭时不挂工具
   */
  tools(): ChatCompletionTool[] {
    return this.enabled ? [kSearchTool] : [];
  }

  list(): readonly MemoryItem[] {
    return this.store.all();
  }

  isWipeCommand(text: string): boolean {
    // 精确匹配而不是 startsWith："清空所有记忆里关于狗的部分"
    // 应该落到抽取器去删一条，不能被误杀成全量清空
    return this.enabled && this.config.wipeKeywords.includes(text);
  }

  /**
   * 执行模型发起的工具调用
   */
  runTool(call: ToolCall, hint: string): string {
    if (call.name !== "search_memory") {
      return `没有名为 ${call.name} 的工具。`;
    }
    let query = "";
    try {
      const args = JSON.parse(call.arguments || "{}") as { query?: unknown };
      query = typeof args.query === "string" ? args.query : "";
    } catch (_) {
      // 参数是模型生成的，可能不是合法 JSON；退化成只用提问原文检索
    }
    return this.search(query, hint);
  }

  /**
   * 检索记忆，返回给模型看的文本
   *
   * 注意：本地打分，<1ms、零网络。tools 和 marker 两种传输共用这一个执行器。
   */
  search(query: string, hint: string): string {
    const items = searchMemories(this.store.all(), query, hint, {
      topK: this.config.recallTopK,
      maxChars: this.config.recallMaxChars,
    });
    console.log(`🔎 search_memory: ${query || "(空)"} → ${items.length} 条`);

    if (items.length) {
      this.store.markUsed(items);
      this.write(() => this.store.save()).catch((e) =>
        console.error("❌ 回写检索命中次数失败", e)
      );
    }
    return formatMemories(items);
  }

  /**
   * 一轮问答落定后调用：落流水 + 进抽取队列
   *
   * 注意：不 await，应答链路无感。每轮都抽取而不是只靠定时任务提炼，
   * 是因为会话在内存里、有 TTL、随时可能重启——经历转瞬即逝，必须当场记。
   */
  onTurn(round: Round) {
    if (!this.enabled) {
      return;
    }
    this.write(() => this.transcript.append(round.sessionId, round.user, round.assistant)).catch(
      (e) => console.error("❌ 写入对话流水失败", e)
    );
    this.pending.push(round);
    this.drain();
  }

  /**
   * 清空长期记忆：画像、库、流水全清，灵魂不动
   */
  async wipe() {
    // 先清积压，否则 wipe 之前那几轮的抽取结果会在 wipe 之后落库，
    // 刚被删掉的信息就"复活"了
    this.pending.length = 0;
    await this.write(() => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const saved = [this.config.file, this.config.profileFile, this.config.transcriptFile]
        .map((e) => backup(e, stamp))
        .filter((e): e is string => !!e);
      this.store.clear();
      this.store.save();
      remove(this.config.profileFile);
      remove(this.config.transcriptFile);
      console.log(`🧹 长期记忆已清空，备份：${saved.join("、") || "（无）"}`);
    });
  }

  /**
   * 挑出抽取时要给模型看的现有记忆
   *
   * 没有它们，模型不知道什么已经记过：会重复 add，也没法 update/delete。
   *
   * 注意：库小的时候直接全给。抽取在异步侧、不占应答速度，不差这点 token，
   * 而"这条是不是已经记过了""该改哪一条"本来就得纵览全局才答得准。
   * 只按线索筛的话，换个说法就漏了——用户说"女儿升三年级了"，
   * 而库里记的是"朵朵今年上二年级"，线索对不上，那条就永远更新不了。
   * 等库真大到塞不下，才退回按线索筛选。
   */
  private related(hint: string): readonly MemoryItem[] {
    const all = this.store.all();
    if (all.length <= kFullContextMax) {
      return all;
    }
    return searchMemories(all, hint, hint, { topK: 20, maxChars: 2000 });
  }

  /**
   * 把写操作排进单写者队列
   */
  private write<T>(fn: () => Promise<T> | T): Promise<T> {
    const task = this.queue.then(fn, fn);
    // 前一个操作失败不能卡住后面的
    this.queue = task.catch(() => undefined);
    return task;
  }

  /**
   * 抽取积压的轮次
   *
   * 注意：worker 串行，每次取走全部积压一次调用处理，队列天然合并批处理
   */
  private drain() {
    if (this.draining || !this.pending.length) {
      return;
    }
    this.draining = true;
    this.write(async () => {
      try {
        while (this.pending.length) {
          await this.extractRounds(this.pending.splice(0));
        }
      } finally {
        this.draining = false;
      }
    })
      .catch((e) => console.error("❌ 记忆抽取失败", e));
  }

  /**
   * 看看该不该巩固
   *
   * @param reason 只用于打日志，两个入口判断条件是一样的
   */
  private maybeConsolidate(reason: string) {
    if (!this.enabled || this.consolidating) {
      return;
    }
    // 注意：这里故意什么都不判断——"有没有新记忆""抽取忙不忙"都不能在这时候问。
    // 触发器只响一次（对话结束就那么一下），而这一刻那轮对话的抽取
    // 多半还在路上：库还没变，pendingChanges 还是 0，一问就是"没新东西"，
    // 这次机会就被白白丢掉，画像只能等明天凌晨那趟兜底。
    // 正确做法是直接排进写队列——队列本来就串行，抽取先跑完，
    // 巩固排在它后面，到那时再判断才作数（见 runConsolidation）。
    this.consolidating = true;
    this.write(() => this.runConsolidation(reason))
      .catch((e) => console.error("❌ 记忆巩固失败", e))
      .finally(() => {
        this.consolidating = false;
      });
  }

  /**
   * 跑一次巩固
   *
   * 注意：这是破坏性操作（替换整个库、重写画像），所以改写前先备份，
   * 任何一步没通过校验就整体保持原状。
   */
  private async runConsolidation(reason: string, force = false): Promise<boolean> {
    // 排到这里时，前面的抽取都已经落库了，这时候问"有没有新记忆"才作数。
    // 没有就空转跳过：库没变，炼出来的画像也一样，白花一次全库调用
    if (!force && !this.store.meta.pendingChanges) {
      return false;
    }

    const before = this.store.size;
    const result = await consolidate(this.llm, {
      memories: this.store.all(),
      transcript: this.transcript.read(),
      profile: this.readProfile(),
      profileMaxChars: this.config.profileMaxChars,
    });
    if (!result) {
      // 失败保持原状，consolidate() 里已经打过日志了
      return false;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup(this.config.file, stamp);
    backup(this.config.profileFile, stamp);

    const stat = this.store.apply(result.ops);
    if (!stat) {
      return false;
    }
    // 模型交白卷时保持原画像不动：宁可旧，也不能把主人手写的东西抹成空白
    if (result.profile) {
      this.writeProfile(result.profile);
    }
    this.store.markConsolidated();
    this.store.save();
    this.transcript.prune();

    console.log(
      `🌙 记忆巩固完成（${reason}）：合并 ${stat.merged}、新增 ${stat.added}、` +
        `更新 ${stat.updated}、删除 ${stat.deleted}，${before} → ${this.store.size} 条；` +
        `画像 ${result.profile.length} 字`
    );
    return true;
  }

  private readProfile(): string {
    try {
      return readFileSync(this.config.profileFile, "utf8").trim();
    } catch (_) {
      return "";
    }
  }

  private writeProfile(text: string) {
    mkdirSync(dirname(this.config.profileFile), { recursive: true });
    const tmp = `${this.config.profileFile}.tmp`;
    writeFileSync(tmp, `${text}\n`, "utf8");
    renameSync(tmp, this.config.profileFile);
  }

  private async extractRounds(rounds: Round[]) {
    const hint = rounds.map((e) => `${e.user} ${e.assistant}`).join(" ");
    const ops = await extract(this.llm, {
      rounds,
      related: this.related(hint),
      subjects: this.store.subjects(),
    });
    if (!ops?.length) {
      // 抽不出东西是常态（闲聊、百科），失败已经在 extract 里打过日志了
      return;
    }

    const stat = this.store.apply(ops);
    if (!stat) {
      return;
    }
    this.store.save();
    console.log(
      `🧠 记忆已更新：新增 ${stat.added}、更新 ${stat.updated}、删除 ${stat.deleted}，共 ${this.store.size} 条`
    );
  }
}
