/**
 * 文本标记协议
 *
 * 部分 OpenAI 兼容服务的流式工具调用不稳（不支持、或 delta 格式跟标准对不上）。
 * 这套协议用纯文本达成同样的语义：模型想检索时，第一行只输出 <搜记忆:朵朵 过敏>，
 * 服务端拦下来、查完、再让它作答。检索执行器、二次调用、次数上限全都复用，
 * 换的只是"模型怎么告诉我它想查"这一层。
 */
export const kMarkerPrefix = "<搜记忆:";
export const kMarkerSuffix = ">";

type State = "sniffing" | "passthrough" | "capturing" | "captured";

/**
 * 嗅探流式输出的开头，判断这是一次检索请求还是一句正常回答
 *
 * 注意：常规回答必须零影响——首字符不是 `<` 就立即透传，
 * 不能为了等一个可能不存在的标记把整句话卡在缓冲区里。
 */
export class MarkerSniffer {
  private state: State = "sniffing";
  private buffer = "";
  private captured?: string;

  /**
   * 模型想检索的关键词，没有则是普通回答
   */
  get query(): string | undefined {
    return this.captured;
  }

  /**
   * 喂一段增量，返回该透传给用户的文本（可能为空）
   */
  push(delta: string): string {
    if (this.state === "passthrough") {
      return delta;
    }
    // 标记已经收全，后面还冒出来的内容一律丢弃：
    // 提示词要求模型输出标记后就停，多出来的都是它没忍住
    if (this.state === "captured") {
      return "";
    }

    this.buffer += delta;
    const text = this.buffer.trimStart();
    if (!text) {
      // 还只有空白，看不出是什么，继续等
      return "";
    }

    if (this.state === "sniffing") {
      if (text.length < kMarkerPrefix.length) {
        // 还不够长，看看有没有可能是标记的开头
        return kMarkerPrefix.startsWith(text) ? "" : this.passthrough();
      }
      if (!text.startsWith(kMarkerPrefix)) {
        return this.passthrough();
      }
      this.state = "capturing";
    }

    const end = text.indexOf(kMarkerSuffix, kMarkerPrefix.length);
    if (end < 0) {
      // 标记还没闭合，继续等
      return "";
    }
    this.captured = text.slice(kMarkerPrefix.length, end).trim();
    this.state = "captured";
    this.buffer = "";
    return "";
  }

  /**
   * 流结束时收尾，返回还压在缓冲区里该透传的文本
   */
  flush(): string {
    if (this.state === "sniffing") {
      // 整条回复短到还没看出是不是标记（比如就一个"好"），原样吐出去
      return this.passthrough();
    }
    if (this.state === "capturing") {
      // 标记开了头却没闭合，多半是被截断了。宁可这轮什么都不说，
      // 也不能把 "<搜记忆:朵朵" 这种东西播给用户听
      console.warn(`⚠️ 检索标记不完整，已丢弃：${this.buffer.slice(0, 40)}`);
      this.buffer = "";
      this.state = "captured";
    }
    return "";
  }

  private passthrough(): string {
    this.state = "passthrough";
    const out = this.buffer;
    this.buffer = "";
    return out;
  }
}
