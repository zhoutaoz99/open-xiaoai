/**
 * 注意：dotenv 必须在其它 import 之前执行。
 * config.ts 是在模块加载时就读 process.env 的，晚一步这些配置就全是空的。
 */
import { config } from "dotenv";
import { resolve } from "node:path";

/**
 * 仓库根目录（examples/assistant）
 *
 * 注意：dist/main.js 和 src/main.ts 到根的层数一样（apps/api/dist、apps/api/src），
 * 所以 build 和 dev 两种跑法都对得上。
 */
const kRoot = resolve(__dirname, "../../..");

config({ path: resolve(kRoot, ".env") });

// .env 里的 data/soul.md 这类相对路径是相对仓库根写的，而进程是在 apps/api 里
// 起来的——不掰回来的话，灵魂会被写到 apps/api/data/soul.md 去，
// 前台读的还是根目录那份，两边永远对不上
process.chdir(kRoot);

/* eslint-disable import/first */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { json } from "express";
import { AppController } from "./app.controller";
import { AppModule } from "./app.module";
import { kAssistantConfig } from "./config";
import { MemoryService } from "./memory/memory.service";

async function main() {
  if (!kAssistantConfig.openai.apiKey) {
    console.error("❌ 未配置 OPENAI_API_KEY，请复制 .env.example 为 .env 后填写");
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule, {
    // Nest 默认的日志前缀在这个项目里只是噪声，保持 v1 那种一行一条的输出
    logger: ["error", "warn"],
  });
  app.enableShutdownHooks();
  // 请求体上限。/chat 收的是一句话，64KB 绰绰有余
  app.use(json({ limit: "64kb" }));
  // 前台默认走自己的服务端代理，不经过这里。但直接开着浏览器调后端排查时要能通
  app.enableCors({ origin: true });

  const { host, port } = kAssistantConfig;
  // 绑 0.0.0.0 而不是 localhost：Docker 里跑的话，只听 localhost 容器外访问不到
  await app.listen(port, host);
  banner(app.get(MemoryService));
}

function banner(memory: MemoryService) {
  const { soul, memory: mem, chat, session, openai } = kAssistantConfig;
  console.log(`✅ 外部对话服务已启动: http://${kAssistantConfig.host}:${kAssistantConfig.port}`);
  console.log(`   模型: ${openai.model}`);
  console.log(`   灵魂: ${soul.soulFile}`);
  console.log(
    `   会话: 最多 ${session.maxTurns} 轮，` +
      `闲置 ${session.ttl / 1000} 秒算聊完（纯内存，重启即清空）`
  );
  if (memory.enabled) {
    console.log(`   记忆: Postgres（已载入 ${memory.size} 条）`);
    console.log(
      `   画像: ${soul.profileFile}（每轮对话结束时炼一版，另每天 ${mem.consolidateAt} 兜底）`
    );
  } else {
    console.log("   记忆: 已关闭（MEMORY_ENABLED=false）");
  }
  if (soul.systemPrompt) {
    console.warn("⚠️ ASSISTANT_SYSTEM_PROMPT 已废弃，它会覆盖灵魂文件，建议改用 soul.md");
  }
  if (!chat.apiKey) {
    console.warn("⚠️ 未配置 ASSISTANT_API_KEY，任何人都能调用本服务");
  }
}

main();
