import { kAssistantConfig } from "../config.js";
import { AssistantServer } from "./server.js";

async function main() {
  if (!kAssistantConfig.openai.apiKey) {
    console.error("❌ 未配置 OPENAI_API_KEY，请复制 .env.example 为 .env 后填写");
    process.exit(1);
  }

  const server = new AssistantServer(kAssistantConfig);
  await server.start();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await server.stop();
      process.exit(0);
    });
  }
}

main();
