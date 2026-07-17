/**
 * 读取 .env 文件里的配置
 *
 * 注意：.env 文件由启动命令里的 --env-file-if-exists=.env 加载，
 * 使用 Docker 运行时，也可以直接通过环境变量传入配置。
 */
export function envString(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

export function envNumber(key: string): number | undefined {
  const value = envString(key);
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  if (Number.isNaN(number)) {
    console.warn(`⚠️ ${key} 不是有效的数字，已忽略该配置：${value}`);
    return undefined;
  }
  return number;
}

export function envBoolean(key: string): boolean | undefined {
  const value = envString(key)?.toLowerCase();
  if (value === undefined) {
    return undefined;
  }
  return ["1", "true", "yes", "on"].includes(value);
}

/**
 * 读取逗号分隔的列表配置，比如：重新开始,清空记忆
 */
export function envList(key: string): string[] | undefined {
  const items = envString(key)
    ?.split(",")
    .map((e) => e.trim())
    .filter((e) => e);
  return items?.length ? items : undefined;
}

/**
 * 大模型的额外请求参数（思考模式、温度等）
 *
 * 注意：没有在 .env 里配置的参数不会发送给大模型服务，
 * 避免部分服务商因为收到不支持的参数而报错。
 */
export function getOpenAICreateParams() {
  const params: Record<string, any> = {};

  const temperature = envNumber("OPENAI_TEMPERATURE");
  if (temperature !== undefined) {
    params.temperature = temperature;
  }

  const thinking = envBoolean("OPENAI_THINKING");
  if (thinking !== undefined) {
    // 思考模式是 DeepSeek 的参数格式，其他服务商的参数格式可能不同
    params.thinking = { type: thinking ? "enabled" : "disabled" };
  }

  return params;
}
