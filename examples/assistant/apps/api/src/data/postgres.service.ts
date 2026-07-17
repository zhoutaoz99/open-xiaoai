import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { DATABASE_CONFIG, type DatabaseConfig } from "./data.types";

/**
 * Postgres 连接池 + 建表
 *
 * 注意：没有迁移工具，也没有任何迁移代码。建表全用 CREATE TABLE IF NOT EXISTS
 * 写在 migrate() 里，随启动自愈——这个项目是给个人部署的，跑一个 migration CLI
 * 的心智负担比它解决的问题大。
 *
 * 注意：**改了表结构就把库删了重建**（`pnpm db:up` 前先 `docker compose down -v`，
 * 或者手动 DROP）。migrate() 只保证「空库能建起来」，不负责把一个老结构的库
 * 改成新结构——CREATE TABLE IF NOT EXISTS 碰到已存在的表是空操作，
 * 加的列不会自己长出来。别指望它帮你迁移。
 */
@Injectable()
export class PostgresService implements OnModuleInit, OnModuleDestroy {
  private pool: Pool;

  constructor(@Inject(DATABASE_CONFIG) private config: DatabaseConfig) {
    this.pool = new Pool({
      connectionString: config.url,
      max: config.poolMax,
      // 连不上就报错，别无限等。撞上一个"端口开着但不是我们的库"的
      // Postgres 时（开发机上很常见），没有这行的话进程会一声不吭地挂住，
      // 既不监听也不报错，排查起来毫无头绪
      connectionTimeoutMillis: 10_000,
    });
    // 连接池里的空闲连接被数据库单方面掐断时，pg 会往 pool 上抛 error。
    // 不接住的话，一次网络抖动就能把整个进程带走
    this.pool.on("error", (e) => console.error("❌ Postgres 连接池报错", e));
  }

  async onModuleInit() {
    try {
      await this.migrate();
    } catch (e) {
      // 连不上数据库时给一句人话。这是启动失败最常见的原因，
      // 而 pg 抛的原始错误（ETIMEDOUT、ECONNREFUSED）看不出该去改什么
      console.error(
        `❌ 连不上 Postgres：${this.config.url}\n` +
          `   先跑 pnpm db:up 起一个，或者改 .env 里的 DATABASE_URL。\n` +
          `   如果你本机已经装了 Postgres，注意别和它撞端口（compose 用的是 5433）。`
      );
      throw e;
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    const result = await this.pool.query<T>(sql, params);
    return result.rows;
  }

  /**
   * 在一个事务里跑一串操作，出错自动回滚
   */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * 建表：随启动自愈
   */
  private async migrate() {
    await this.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id           text PRIMARY KEY,
        content      text NOT NULL,
        type         text NOT NULL,
        subjects     text[] NOT NULL DEFAULT '{}',
        keywords     text[] NOT NULL DEFAULT '{}',
        importance   integer NOT NULL DEFAULT 3,
        due_at       text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        hits         integer NOT NULL DEFAULT 0,
        last_used_at timestamptz,
        payload      jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);

    // 一次对话
    //
    // 注意：段的边界不在这里算——它由 SessionService 在会话窗口建起来时就定了
    // （一次对话 = 一个会话窗口的生命周期），这张表只是把当时的结论存下来。
    // turns / ended_at 每落一轮就顺手更新一次，前台读它不用做任何聚合。
    await this.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id         text PRIMARY KEY,
        session_id text NOT NULL,
        title      text NOT NULL DEFAULT '',
        turns      integer NOT NULL DEFAULT 0,
        started_at timestamptz NOT NULL DEFAULT now(),
        ended_at   timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.query(
      `CREATE INDEX IF NOT EXISTS conversations_started_idx ON conversations (started_at DESC, id DESC)`
    );

    // 对话轮次
    await this.query(`
      CREATE TABLE IF NOT EXISTS turns (
        id              bigserial PRIMARY KEY,
        conversation_id text REFERENCES conversations (id) ON DELETE CASCADE,
        session_id      text NOT NULL,
        user_text       text NOT NULL,
        assistant_text  text NOT NULL DEFAULT '',
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.query(
      `CREATE INDEX IF NOT EXISTS turns_session_created_idx ON turns (session_id, created_at DESC, id DESC)`
    );
    await this.query(
      `CREATE INDEX IF NOT EXISTS turns_created_idx ON turns (created_at DESC, id DESC)`
    );
    await this.query(
      `CREATE INDEX IF NOT EXISTS turns_conversation_idx ON turns (conversation_id, created_at, id)`
    );

    // 提炼记录：每轮抽取了什么、每次巩固把画像改成了什么
    //
    // 注意：turn_ids 是数组而不是单个外键——抽取是批处理的，
    // 队列积压时一次调用会同时消化好几轮（见 MemoryService.drain）
    await this.query(`
      CREATE TABLE IF NOT EXISTS extractions (
        id         bigserial PRIMARY KEY,
        kind       text NOT NULL,
        status     text NOT NULL,
        session_id text,
        turn_ids   bigint[] NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        payload    jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await this.query(
      `CREATE INDEX IF NOT EXISTS extractions_created_idx ON extractions (created_at DESC, id DESC)`
    );
    await this.query(
      `CREATE INDEX IF NOT EXISTS extractions_turn_ids_idx ON extractions USING gin (turn_ids)`
    );

    // 巩固任务的元信息，永远只有一行
    await this.query(`
      CREATE TABLE IF NOT EXISTS memory_meta (
        id                   integer PRIMARY KEY DEFAULT 1,
        last_consolidated_at timestamptz,
        pending_changes      integer NOT NULL DEFAULT 0,
        CONSTRAINT memory_meta_single_row CHECK (id = 1)
      )
    `);
    await this.query(`INSERT INTO memory_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

    // 后悔药：清空和巩固前把整个库拍一张快照存这儿
    //
    // 注意：这是原来 data/*.bak 文件的替代。一句话（还可能是语音识别错的）
    // 触发的不可逆操作是大忌，必须留一条退路
    await this.query(`
      CREATE TABLE IF NOT EXISTS memory_snapshots (
        id         bigserial PRIMARY KEY,
        reason     text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        memories   jsonb NOT NULL,
        profile    text NOT NULL DEFAULT ''
      )
    `);
    await this.query(
      `CREATE INDEX IF NOT EXISTS memory_snapshots_created_idx ON memory_snapshots (created_at DESC)`
    );

    // 待办与主动提醒
    //
    // 注意：这和 memories 里的 event/task 是两回事（见 docs/todo.md 三）。
    // due_at 是 timestamptz（精确到分的播报时刻），不是 memories.due_at 那种
    // 日历日字符串——主动提醒要几点几分，日期不够用。
    // fired_at 是触发幂等的关键：非空就不再 fire，重启也不重放。
    await this.query(`
      CREATE TABLE IF NOT EXISTS todos (
        id            text PRIMARY KEY,
        content       text NOT NULL,
        due_at        timestamptz,
        remind        boolean NOT NULL DEFAULT true,
        status        text NOT NULL DEFAULT 'pending',
        fired_at      timestamptz,
        snoozed_until timestamptz,
        source        text NOT NULL DEFAULT 'voice',
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      )
    `);
    // 调度器每分钟扫"到期未 fire 的 pending 提醒"，给这条路建索引
    await this.query(
      `CREATE INDEX IF NOT EXISTS todos_due_idx ON todos (due_at) WHERE status = 'pending'`
    );
  }
}
