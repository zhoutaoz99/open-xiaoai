export interface SoulConfig {
  /**
   * 灵魂文件：性格、说话风格、自称、边界
   *
   * 注意：系统永不改写，只有用户（和前台的编辑器）能写。
   * 助手不该悄悄改变自己的性格。
   */
  soulFile: string;
  /**
   * 画像文件：对用户和家庭的理解
   */
  profileFile: string;
  /**
   * 旧版系统提示词（deprecated）
   *
   * 注意：设置后整体替换「灵魂 + 播报约束」
   */
  systemPrompt?: string;
  /**
   * 记忆是否开启，关闭时不注入画像、不说明记忆工具
   */
  memoryEnabled: boolean;
  /**
   * 记忆检索的传输方式，决定说明书里怎么教模型发起检索
   */
  recallTransport: "tools" | "marker";
  /**
   * 画像预算（字）
   */
  profileMaxChars: number;
}

/**
 * 一份可编辑的文档，给前台的编辑器用
 */
export interface SoulDocument {
  path: string;
  text: string;
  /**
   * 文件不存在时为 null
   */
  updatedAt: string | null;
  /**
   * 字数（画像有预算，前台要显示还剩多少）
   */
  chars: number;
  maxChars?: number;
}

export const SOUL_CONFIG = Symbol("SOUL_CONFIG");
