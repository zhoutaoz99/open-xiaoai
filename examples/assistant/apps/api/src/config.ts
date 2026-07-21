import type { ChatConfig, SessionConfig } from "./chat/chat.types";
import type { DatabaseConfig } from "./data/data.types";
import type { LLMConfig } from "./llm/llm.types";
import type { MemoryConfig } from "./memory/memory.types";
import type { SoulConfig } from "./soul/soul.types";
import type { TodoConfig } from "./todo/todo.types";
import { envBoolean, envList, envNumber, envString, getOpenAICreateParams } from "./env";

export interface AssistantConfig {
  /**
   * 服务监听的端口（在 .env 文件里配置）
   */
  port: number;
  /**
   * 服务监听的地址（在 .env 文件里配置）
   *
   * 注意：在 Docker 里运行时必须是 0.0.0.0，否则容器外访问不到
   */
  host: string;
  database: DatabaseConfig;
  openai: LLMConfig;
  chat: ChatConfig;
  session: SessionConfig;
  soul: SoulConfig;
  memory: MemoryConfig;
  todo: TodoConfig;
}

/**
 * 全局配置：模块加载时从环境变量读一次
 *
 * 注意：各模块通过自己的 DI token 拿到对应的那一片（见 *.module.ts），
 * 服务本身不直接 import 这个常量，方便单测时换掉。
 */
export const kAssistantConfig: AssistantConfig = {
  port: envNumber("ASSISTANT_PORT") ?? 8000,
  host: envString("ASSISTANT_HOST") ?? "0.0.0.0",
  database: {
    /**
     * Postgres 连接串（在 .env 文件里配置）
     *
     * 注意：记忆库、对话轮次、提炼记录都在这里。灵魂和画像不在——
     * 它们是给人看、给人改的，见 soul 配置段。
     *
     * 注意：默认端口是 5433 不是 5432，和 docker-compose.yml 对齐——
     * 开发机上常常已经有一个自己装的 Postgres 占着 5432，
     * 撞上的话轻则连不上，重则往人家库里建表。
     */
    url:
      envString("DATABASE_URL") ?? "postgres://postgres:postgres@127.0.0.1:5433/assistant",
    /**
     * 连接池上限（在 .env 文件里配置）
     */
    poolMax: envNumber("DATABASE_POOL_MAX") ?? 10,
  },
  openai: {
    /**
     * 你的大模型服务提供商的接口地址（在 .env 文件里配置）
     *
     * 支持兼容 OpenAI 接口的大模型服务，比如：DeepSeek V3 等
     *
     * 注意：一般以 /v1 结尾，不包含 /chat/completions 部分
     * - ✅ https://api.openai.com/v1
     * - ❌ https://api.openai.com/v1/（最后多了一个 /）
     * - ❌ https://api.openai.com/v1/chat/completions（不需要加 /chat/completions）
     */
    baseURL: envString("OPENAI_BASE_URL"),
    /**
     * API 密钥（在 .env 文件里配置）
     */
    apiKey: envString("OPENAI_API_KEY"),
    /**
     * 模型名称（在 .env 文件里配置）
     */
    model: envString("OPENAI_MODEL"),
    /**
     * 思考模式、温度等额外的请求参数（在 .env 文件里配置）
     */
    createParams: getOpenAICreateParams(),
  },
  chat: {
    /**
     * API 密钥（在 .env 文件里配置）
     *
     * 注意：要和 migpt 的 AGENT_API_KEY 保持一致，未配置时不校验
     */
    apiKey: envString("ASSISTANT_API_KEY"),
    /**
     * 调用大模型失败时的兜底话术（在 .env 文件里配置）
     */
    errorText: envString("ASSISTANT_ERROR_TEXT") ?? "我这边出了点问题，请稍后再试。",
    /**
     * 命中这些关键词时清空**会话上下文**（在 .env 文件里配置）
     *
     * 注意：这里清的是最近几轮对话，不碰长期记忆。
     * 默认值里原本有"清空记忆"，引入长期记忆后语义有歧义，已移除——
     * 想清长期记忆用 MEMORY_WIPE_KEYWORDS。
     */
    resetKeywords: envList("ASSISTANT_RESET_KEYWORDS") ?? ["重新开始", "忘掉刚才"],
    /**
     * 清空上下文后的回复话术（在 .env 文件里配置）
     */
    resetText: envString("ASSISTANT_RESET_TEXT") ?? "好的，我们重新开始吧。",
    /**
     * 命中这些关键词时退出连续对话（在 .env 文件里配置）
     *
     * 注意：前缀匹配，和 resetKeywords 一致。只有 migpt 开了 KEEP_AWAKE
     * 时才有可见效果——响应里带上 keep_awake:false，告诉 migpt 播完这句
     * 告别就别再开收音窗口，见 PROTOCOL.md。
     */
    exitKeywords: envList("ASSISTANT_EXIT_KEYWORDS") ?? ["关闭", "退下", "没事了", "再见", "拜拜"],
    /**
     * 退出连续对话时的告别话术（在 .env 文件里配置）
     */
    exitText: envString("ASSISTANT_EXIT_TEXT") ?? "好的，不打扰了。",
  },
  session: {
    /**
     * 一轮对话最多记住多少问答（在 .env 文件里配置）
     *
     * 注意：单位是「轮」，一轮 = 一问一答。
     * 这是安全阀不是目标：真正决定对话有多长的是下面的 ttl——
     * 五分钟里说不到一百轮，所以绝大多数对话根本碰不到这个上限，
     * 只有真聊了很久时它才生效，而那时你正需要这些上下文。
     */
    maxTurns: envNumber("ASSISTANT_MAX_TURNS") ?? 100,
    /**
     * 闲置多少秒算这轮对话结束（在 .env 文件里配置）
     *
     * 注意：协议里没有唤醒边界（session_id 是固定的），所以"聊完了"
     * 只能靠静默判定。到点做两件事：清空会话窗口、炼一版画像。
     */
    ttl: (envNumber("ASSISTANT_SESSION_TTL_SECONDS") ?? 300) * 1000,
  },
  soul: getSoulConfig(),
  memory: getMemoryConfig(),
  todo: getTodoConfig(),
};

/**
 * 灵魂与画像配置
 *
 * 注意：这两份是整个系统里仅存的文件——记忆库和对话轮次都进 Postgres 了。
 * 它们留在文件里不是偷懒：灵魂和画像是给人看、给人改的，Markdown 比
 * 数据库里的一个 text 列称手得多，改完存盘下一句话就生效。
 */
function getSoulConfig(): SoulConfig {
  return {
    /**
     * 灵魂文件：性格、说话风格、自称、边界（在 .env 文件里配置）
     *
     * 注意：系统永不改写它，只有你和前台能改；文件不存在时首次启动会生成模板。
     * 它不受 MEMORY_ENABLED 影响——人格不是记忆。
     */
    soulFile: envString("ASSISTANT_SOUL_FILE") ?? "data/soul.md",
    /**
     * 画像文件：助手对这个家的理解（在 .env 文件里配置）
     */
    profileFile: envString("MEMORY_PROFILE_FILE") ?? "data/profile.md",
    /**
     * 旧版系统提示词（在 .env 文件里配置）
     *
     * 注意：已废弃。设置后会整体替换「灵魂 + 播报约束」，建议改用 soul.md。
     */
    systemPrompt: envString("ASSISTANT_SYSTEM_PROMPT"),
    memoryEnabled: envBoolean("MEMORY_ENABLED") ?? true,
    recallTransport: envString("MEMORY_RECALL_TRANSPORT") === "marker" ? "marker" : "tools",
    profileMaxChars: envNumber("MEMORY_PROFILE_MAX_CHARS") ?? 1000,
  };
}

/**
 * 长期记忆配置
 */
function getMemoryConfig(): MemoryConfig {
  return {
    /**
     * 记忆总开关（在 .env 文件里配置）
     *
     * 注意：关闭后回到纯内存版，但灵魂照常生效
     */
    enabled: envBoolean("MEMORY_ENABLED") ?? true,
    /**
     * 对话轮次保留天数（在 .env 文件里配置）
     *
     * 注意：设 0 则不落轮次，库里不留对话原文（前台的对话记录也会是空的）
     */
    transcriptDays: envNumber("MEMORY_TRANSCRIPT_DAYS") ?? 14,
    /**
     * 提炼记录保留天数（在 .env 文件里配置）
     *
     * 注意：这是给前台看的审计流水，不参与任何模型调用。
     * 比对话轮次留得久一点：轮次过期了，"当时从它身上学到了什么"还有回顾价值。
     */
    extractionDays: envNumber("MEMORY_EXTRACTION_DAYS") ?? 30,
    /**
     * 单次检索最多返回多少条（在 .env 文件里配置）
     */
    recallTopK: envNumber("MEMORY_RECALL_TOP_K") ?? 8,
    /**
     * 单次检索结果的长度预算，单位字（在 .env 文件里配置）
     */
    recallMaxChars: envNumber("MEMORY_RECALL_MAX_CHARS") ?? 1500,
    /**
     * 每个请求最多允许几轮带检索的模型往返（在 .env 文件里配置）
     *
     * 注意：达到上限后会摘掉工具逼模型作答，防止它查完再查停不下来。
     * 数的是往返轮次，不是工具调用条数——模型可能在一轮里并行查好几个词，
     * 那也只是一次往返，而检索本身是本地的，不要钱。
     */
    searchMaxCalls: envNumber("MEMORY_SEARCH_MAX_CALLS") ?? 2,
    /**
     * 检索时先播的填补话术（在 .env 文件里配置）
     *
     * 注意：检索要多一次模型往返，干等着像是卡死了。置空关闭。
     */
    searchFiller: envString("MEMORY_SEARCH_FILLER") ?? "让我想想。",
    /**
     * 记忆检索的传输方式（在 .env 文件里配置）
     *
     * 注意：部分 OpenAI 兼容服务的流式工具调用不稳（不支持、或 delta 格式不同），
     * 那种情况下换成 marker 文本标记协议，语义完全不变、只换传输。
     */
    recallTransport: envString("MEMORY_RECALL_TRANSPORT") === "marker" ? "marker" : "tools",
    /**
     * 画像预算，单位字（在 .env 文件里配置）
     */
    profileMaxChars: envNumber("MEMORY_PROFILE_MAX_CHARS") ?? 1000,
    /**
     * 每天几点兜底巩固一次，本地时间（在 .env 文件里配置）
     *
     * 注意：画像正常是每轮对话结束时就炼好的（见 ASSISTANT_SESSION_TTL_SECONDS）。
     * 这一趟只收拾等不到"对话结束"的残局，比如聊到一半重启了。
     * 没有新记忆时空转跳过，不会重复生成。
     */
    consolidateAt: envString("MEMORY_CONSOLIDATE_AT") ?? "03:00",
    /**
     * 命中这些关键词时清空长期记忆（在 .env 文件里配置）
     *
     * 注意：精确匹配整句，不是前缀匹配——"清空所有记忆里关于狗的部分"
     * 应该落到抽取器去删一条，不能被误杀成全量清空
     */
    wipeKeywords: envList("MEMORY_WIPE_KEYWORDS") ?? ["清空所有记忆"],
    /**
     * 清空长期记忆后的回复话术（在 .env 文件里配置）
     */
    wipeText: envString("MEMORY_WIPE_TEXT") ?? "好的，我已经把记住的事情都忘掉了。",
    /**
     * 抽取记忆专用的大模型（在 .env 文件里配置）
     *
     * 注意：缺省复用主模型的配置。抽取在异步侧、不占应答路径，
     * 可以配一个便宜的模型。
     *
     * 这里刻意不继承主模型的温度和思考模式：抽取要的是稳定的 JSON，
     * 不是有创意的发挥。
     */
    openai: {
      baseURL: envString("MEMORY_OPENAI_BASE_URL") ?? envString("OPENAI_BASE_URL"),
      apiKey: envString("MEMORY_OPENAI_API_KEY") ?? envString("OPENAI_API_KEY"),
      model: envString("MEMORY_OPENAI_MODEL") ?? envString("OPENAI_MODEL"),
    },
  };
}

/**
 * 待办与主动提醒配置
 *
 * 注意：措辞用的模型直接复用记忆模型（MEMORY_LLM），不单独配一份——
 * 抽取、巩固、提醒措辞都是后台的便宜活儿，共用一个便宜模型就够了。
 */
function getTodoConfig(): TodoConfig {
  return {
    /**
     * 待办总开关（在 .env 文件里配置）
     *
     * 注意：关了不挂待办工具、不启动提醒调度器
     */
    enabled: envBoolean("TODO_ENABLED") ?? true,
    /**
     * migpt 的推送地址，形如 http://127.0.0.1:4400（在 .env 文件里配置）
     *
     * 注意：这条推送通道早在 PROTOCOL.md 里定义好了，
     * 到点主动提醒就走它。没配则提醒只打日志（功能降级不报错）。
     */
    pushUrl: envString("AGENT_PUSH_URL"),
    /**
     * 推送鉴权密钥，要和 migpt 的 AGENT_PUSH_API_KEY 一致（在 .env 文件里配置）
     */
    pushApiKey: envString("AGENT_PUSH_API_KEY"),
    /**
     * 调度器扫描间隔，单位秒（在 .env 文件里配置）
     */
    scanSeconds: envNumber("REMINDER_SCAN_SECONDS") ?? 60,
    /**
     * 迟到多久就不再补播，单位分钟（在 .env 文件里配置）
     *
     * 注意：migpt 断线一段时间再恢复，不该把积压的提醒一口气全念了
     */
    maxLateMinutes: envNumber("REMINDER_MAX_LATE_MINUTES") ?? 120,
    /**
     * 只给了日期没给时刻的待办，默认几点提醒，形如 09:00（在 .env 文件里配置）
     */
    defaultTime: envString("REMINDER_DEFAULT_TIME") ?? "09:00",
  };
}
