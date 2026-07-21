import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { LLM } from "../llm/llm.service";
import { MEMORY_LLM, type ToolCall } from "../llm/llm.types";
import { SoulService } from "../soul/soul.service";
import { TranscriptService } from "../transcript/transcript.service";
import { consolidate, kMaxTranscript } from "./consolidator";
import { extract } from "./extractor";
import { MemoryRepository } from "./memory.repository";
import { MemoryStore } from "./memory.store";
import {
  MEMORY_CONFIG,
  today,
  type ExtractionRecord,
  type ListExtractionsQuery,
  type MemoryChanges,
  type MemoryConfig,
  type MemoryItem,
  type Round,
} from "./memory.types";
import { formatMemories, searchMemories } from "./search";

/**
 * 一天
 */
const kDay = 24 * 60 * 60 * 1000;

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
      "用户问他自己的事（我是谁、我叫什么、我的车牌号是多少）也要用它检索。" +
      "声纹识别到说话人时，用他的名字检索（如「周涛 名字」），否则用「用户」。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "空格分隔的检索词：人名、事物、主题。问用户自己的事就用「用户」当人称，比如：用户 名字；问家人就用名字，比如：朵朵 过敏。声纹识别到说话人时用他的名字，比如：周涛 名字",
        },
      },
      required: ["query"],
    },
  },
};

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
 * 长期记忆的对外唯一门面
 *
 * 注意：所有写操作都走同一条 promise 链串行执行（单写者队列），
 * 与 SessionService.lock() 相互独立。
 */
@Injectable()
export class MemoryService implements OnModuleInit, OnApplicationShutdown {
  private store = new MemoryStore();
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
  /**
   * 巩固进行中又来了新的触发：记一笔，炼完补一次。详见 maybeConsolidate()
   */
  private consolidatePending?: string;
  private timer?: NodeJS.Timeout;
  private consolidateTimer?: NodeJS.Timeout;

  constructor(
    @Inject(MEMORY_CONFIG) private config: MemoryConfig,
    @Inject(MEMORY_LLM) private llm: LLM,
    private repo: MemoryRepository,
    private transcript: TranscriptService,
    private soul: SoulService
  ) {}

  get enabled() {
    return this.config.enabled;
  }

  get size() {
    return this.store.size;
  }

  /**
   * 正在巩固画像（给前台状态轮询用）
   *
   * 注意：字段叫 consolidating，getter 不能重名，所以用 isConsolidating
   */
  get isConsolidating() {
    return this.consolidating;
  }

  /**
   * 上次巩固以来的记忆变更数：>0 说明有新记忆还没进画像
   */
  get pendingChanges() {
    return this.store.meta.pendingChanges;
  }

  /**
   * 上次巩固完成的时间
   */
  get lastConsolidatedAt() {
    return this.store.meta.lastConsolidatedAt;
  }

  async onModuleInit() {
    if (!this.enabled) {
      return;
    }
    await this.load();
    await this.write(() => this.prune());

    // 流水和提炼记录没人清就会一直涨。巩固时会顺手清，但一个常年
    // 不重启、又没什么新记忆的实例可能很久都不巩固一次，所以自己也扫
    this.timer = setInterval(() => {
      this.write(() => this.prune()).catch((e) => console.error("❌ 清理过期数据失败", e));
    }, kDay);
    this.timer.unref();

    // 睡眠式巩固：低频、后台、不赶时间。
    // 注意：这里只是"多久看一眼"，到没到点由 nextTime() 拿当前时间算。
    // 直接把 setInterval 设成 24 小时是错的——那是按进程运行时长计时，
    // 每天重启一次服务，这个点就永远等不到，画像永远炼不出来。
    this.scheduleDaily();
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
    clearTimeout(this.consolidateTimer);
    this.timer = undefined;
    this.consolidateTimer = undefined;
  }

  /**
   * 从库里载入内存镜像
   */
  private async load() {
    const [memories, meta] = await Promise.all([this.repo.all(), this.repo.meta()]);
    this.store.load(memories, meta);
  }

  private async prune() {
    await this.transcript.prune();
    const removed = await this.repo.pruneExtractions(this.config.extractionDays);
    if (removed) {
      console.log(`🧹 已清理 ${removed} 条过期提炼记录（保留 ${this.config.extractionDays} 天）`);
    }
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
   * 立刻巩固一次，不管有没有新记忆（给前台的按钮和排查用）
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
      // 手动巩固期间要是有对话刚好结束触发了 onIdle，别把它丢了
      this.flushPendingConsolidation();
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

  listExtractions(query: ListExtractionsQuery): Promise<ExtractionRecord[]> {
    return this.repo.listExtractions(query);
  }

  listSnapshots(limit: number) {
    return this.repo.listSnapshots(limit);
  }

  isWipeCommand(text: string): boolean {
    // 精确匹配而不是 startsWith："清空所有记忆里关于狗的部分"
    // 应该落到抽取器去删一条，不能被误杀成全量清空
    return this.enabled && this.config.wipeKeywords.includes(text);
  }

  /**
   * 前台手动删一条
   *
   * 注意：也记一条提炼记录。手动删除同样是"记忆为什么变成这样"的一环，
   * 只有模型的操作进流水、人的操作不进，那这份审计就是假的。
   */
  async remove(id: string): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }
    return this.write(async () => {
      const item = this.store.remove(id);
      if (!item) {
        return false;
      }
      await this.persist({ upserts: [], deletes: [id] });
      await this.repo.addExtraction({
        kind: "extract",
        status: "ok",
        turnIds: [],
        applied: [{ op: { op: "delete", id }, id, content: item.content }],
        stat: { added: 0, updated: 0, deleted: 1, merged: 0 },
        reason: "前台手动删除",
      });
      console.log(`🗑️ 已手动删除记忆 ${id}：${item.content}`);
      return true;
    });
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
      const used = this.store.markUsed(items);
      this.write(() => this.repo.markUsed(used)).catch((e) =>
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
    this.write(async () => {
      let turnId: string | undefined;
      try {
        const turn = await this.transcript.append(
          round.conversationId,
          round.sessionId,
          round.user,
          round.assistant
        );
        turnId = turn?.id;
      } catch (e) {
        // 流水没落上不影响记忆：用户说的话在 user 消息里，该记还得记。
        // 只是这条提炼记录挂不回具体哪一轮了
        console.error("❌ 写入对话流水失败", e);
      }
      this.pending.push({ ...round, turnId });
      this.drain();
    }).catch((e) => console.error("❌ 处理对话轮次失败", e));
  }

  /**
   * 清空长期记忆：画像、库、流水、提炼记录全清，灵魂不动
   *
   * 注意：提炼记录也要清。它里面存着当时抽出来的记忆原文和 evidence——
   * 那和记忆库里的是同一份隐私，只清库不清它等于没清。
   */
  async wipe() {
    // 先清积压，否则 wipe 之前那几轮的抽取结果会在 wipe 之后落库，
    // 刚被删掉的信息就"复活"了
    this.pending.length = 0;
    // 攒着的巩固触发也一并作废：清空之后没什么可巩固的
    this.consolidatePending = undefined;
    await this.write(async () => {
      const profile = this.soul.profileText();
      // 后悔药：一句话（还可能是语音识别错的）触发的不可逆操作是大忌
      await this.repo.snapshot("wipe", this.store.all(), profile);
      const bak = this.soul.backupProfile();

      this.store.clear();
      await this.repo.clear();
      await this.repo.clearExtractions();
      await this.transcript.clear();
      this.soul.removeProfile();

      console.log(
        `🧹 长期记忆已清空，可从 memory_snapshots 表恢复${bak ? `；画像备份：${bak}` : ""}`
      );
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
   * 把改动落库
   *
   * 注意：内存镜像已经改过了，落库失败就意味着两边不一致。
   * 这时候从库里重新载入一遍——宁可丢掉这批刚抽出来的记忆，
   * 也不能让镜像和库长期各说各话（检索读的是镜像，前台读的是库）。
   */
  private async persist(changes: MemoryChanges) {
    try {
      await this.repo.applyChanges(changes, this.store.meta);
    } catch (e) {
      console.error("❌ 记忆落库失败，正在从库里重新载入内存镜像", e);
      await this.load().catch(() => undefined);
      throw e;
    }
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
    }).catch((e) => console.error("❌ 记忆抽取失败", e));
  }

  /**
   * 看看该不该巩固
   *
   * @param reason 只用于打日志和提炼记录，两个入口判断条件是一样的
   */
  private maybeConsolidate(reason: string) {
    if (!this.enabled) {
      return;
    }
    // 已经在炼了：别把这次触发丢掉。抽取比巩固慢，慢一轮抽出来的记忆
    // 常常赶不上正在跑的这班巩固——上一版就是这么漏掉"用户喜欢吃辣"的：
    // 它抽完时，那唯一一次巩固早跑过去了，早退直接把这次触发扔了。
    // 记一笔，炼完补一次；多个触发挤在一起也只补一次（下一次巩固自然会把
    // 这期间所有新记忆都收进去），不叠加。
    if (this.consolidating) {
      this.consolidatePending = reason;
      return;
    }
    this.startConsolidation(reason);
  }

  /**
   * 起一次巩固，跑完若期间又有触发就自动再补一次
   *
   * 注意：故意直接排进写队列，不在入队前判断"有没有新记忆"——触发器只响
   * 一次（对话结束就那么一下），而这一刻那轮对话的抽取多半还在路上：
   * 库还没变、pendingChanges 还是 0，一问就是"没新东西"，这次机会就白丢了。
   * 队列本来就串行，抽取先跑完、巩固排在它后面，到那时再判断才作数
   * （见 runConsolidation）。
   */
  private startConsolidation(reason: string) {
    this.consolidating = true;
    this.write(() => this.runConsolidation(reason))
      .catch((e) => console.error("❌ 记忆巩固失败", e))
      .finally(() => {
        this.consolidating = false;
        this.flushPendingConsolidation();
      });
  }

  /**
   * 巩固进行中攒下的触发，炼完补跑一次（没有新记忆时 runConsolidation 会空转跳过）
   */
  private flushPendingConsolidation() {
    if (!this.enabled || this.consolidating || this.consolidatePending === undefined) {
      return;
    }
    const reason = this.consolidatePending;
    this.consolidatePending = undefined;
    this.startConsolidation(reason);
  }

  /**
   * 跑一次巩固
   *
   * 注意：这是破坏性操作（替换整个库、重写画像），所以改写前先拍快照，
   * 任何一步没通过校验就整体保持原状。
   */
  private async runConsolidation(reason: string, force = false): Promise<boolean> {
    // 排到这里时，前面的抽取都已经落库了，这时候问"有没有新记忆"才作数。
    // 没有就空转跳过：库没变，炼出来的画像也一样，白花一次全库调用
    if (!force && !this.store.meta.pendingChanges) {
      return false;
    }

    const before = this.store.size;
    const profileBefore = this.soul.profileText();
    const { result, error } = await consolidate(this.llm, {
      memories: this.store.all(),
      transcript: await this.transcript.recent(kMaxTranscript),
      profile: profileBefore,
      profileMaxChars: this.config.profileMaxChars,
    });

    if (!result) {
      // 失败保持原状，consolidate() 里已经打过日志了
      await this.repo.addExtraction({
        kind: "consolidate",
        status: "failed",
        turnIds: [],
        error,
        reason,
      });
      return false;
    }

    // 后悔药：换库、改画像之前先拍一张
    await this.repo.snapshot("consolidate", this.store.all(), profileBefore);

    const applied = this.store.apply(result.ops);
    if (!applied) {
      await this.repo.addExtraction({
        kind: "consolidate",
        status: "failed",
        turnIds: [],
        error: "操作校验不通过，整批丢弃",
        reason,
      });
      return false;
    }

    // 巩固会合并、删除，改动面比一次抽取大得多，整库换掉最省心
    this.store.markConsolidated();
    await this.repo.replaceAll(this.store.all(), this.store.meta);

    // 模型交白卷时保持原画像不动：宁可旧，也不能把主人手写的东西抹成空白
    if (result.profile) {
      this.soul.writeProfile(result.profile);
    }
    await this.prune();

    await this.repo.addExtraction({
      kind: "consolidate",
      status: applied.applied.length || result.profile !== profileBefore ? "ok" : "empty",
      turnIds: [],
      applied: applied.applied,
      stat: applied.stat,
      profileBefore,
      profileAfter: result.profile || profileBefore,
      reason,
    });

    console.log(
      `🌙 记忆巩固完成（${reason}）：合并 ${applied.stat.merged}、新增 ${applied.stat.added}、` +
        `更新 ${applied.stat.updated}、删除 ${applied.stat.deleted}，${before} → ${this.store.size} 条；` +
        `画像 ${result.profile.length} 字`
    );
    return true;
  }

  private async extractRounds(rounds: Round[]) {
    const hint = rounds.map((e) => `${e.user} ${e.assistant}`).join(" ");
    const turnIds = rounds.map((e) => e.turnId).filter((e): e is string => !!e);
    const sessionId = rounds[0]?.sessionId ?? null;
    const speaker = rounds.find((e) => e.speaker)?.speaker;

    const { ops, error } = await extract(this.llm, {
      rounds,
      related: this.related(hint),
      subjects: this.store.subjects(),
      speaker,
    });

    if (!ops) {
      await this.repo.addExtraction({
        kind: "extract",
        status: "failed",
        sessionId,
        turnIds,
        error,
      });
      return;
    }

    if (!ops.length) {
      // 抽不出东西是常态（闲聊、百科）。照样记一笔——
      // "这轮什么都没记"本身就是前台要回答的问题
      await this.repo.addExtraction({
        kind: "extract",
        status: "empty",
        sessionId,
        turnIds,
      });
      return;
    }

    const applied = this.store.apply(ops);
    if (!applied) {
      await this.repo.addExtraction({
        kind: "extract",
        status: "failed",
        sessionId,
        turnIds,
        error: "操作校验不通过，整批丢弃",
      });
      return;
    }

    await this.persist(applied.changes);
    await this.repo.addExtraction({
      kind: "extract",
      status: "ok",
      sessionId,
      turnIds,
      applied: applied.applied,
      stat: applied.stat,
    });

    console.log(
      `🧠 记忆已更新：新增 ${applied.stat.added}、更新 ${applied.stat.updated}、` +
        `删除 ${applied.stat.deleted}，共 ${this.store.size} 条`
    );
  }
}
