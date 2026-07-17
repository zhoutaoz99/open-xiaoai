export interface DatabaseConfig {
  /**
   * Postgres 连接串
   */
  url: string;
  /**
   * 连接池上限
   */
  poolMax: number;
}

/**
 * 数据库配置的 DI token
 */
export const DATABASE_CONFIG = Symbol("DATABASE_CONFIG");
