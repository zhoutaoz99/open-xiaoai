import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const kSearchTool: ChatCompletionTool = {
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

export const kTodoTools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "add_todo",
      description:
        "记一条待办，或设一个到点主动提醒用户的事项。用户说「提醒我…」「记一下要…」「别让我忘了…」这类话时用它。" +
        "重要：调用时**不要同时说话或解释**，直接调用工具；等工具返回结果后，再用一句话确认即可——否则用户会先听到你的话、再听到确认，等于回了两遍。" +
        "如果上下文中有【说话人】（声纹识别），content 里要带上是谁的事，如「周涛：三点开会」，方便区分不同家人的待办。",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "要做或要提醒的事，一句话，如：三点开会 / 买牛奶",
          },
          dueAt: {
            type: "string",
            description:
              "提醒时刻，绝对时间 ISO 格式，如 2026-07-18T15:00:00+08:00。上下文的【现在】给了当前日期和时间，据它把「两分钟后」「半小时后」「三点」「明天上午」这类相对说法换算成绝对时刻——相对时间尤其要按【现在】算，不能猜；没有明确时间就省略这个参数。",
          },
          remind: {
            type: "boolean",
            description:
              "到点是否主动开口提醒。用户说「提醒我」时为 true；只是「记一下、列个清单」不用主动提醒时为 false。默认 true。",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_todos",
      description: "列出当前的待办事项。用户问「我有哪些待办」「还有什么没做」时用它。",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending", "done", "cancelled"],
            description: "筛选状态，默认 pending（未完成）",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_todo",
      description:
        "把一条待办标记为完成。用户说「…做完了」「买好了」时用它；不确定 id 就先用 list_todos 查。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "待办 id，形如 t_x7k2p9" },
        },
        required: ["id"],
      },
    },
  },
];
