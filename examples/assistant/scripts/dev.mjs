/**
 * 并行拉起前后端
 *
 * 注意：任何一个挂了就把另一个也带走。否则前台还开着、后端已经死了，
 * 页面上只会看到一片请求失败，得翻半天日志才发现是后端没了。
 */
import { spawn } from "node:child_process";

const apps = [
  { name: "api", color: "\x1b[36m", filter: "@assistant/api" },
  { name: "web", color: "\x1b[35m", filter: "@assistant/web" },
];

const children = [];
let stopping = false;

for (const app of apps) {
  const child = spawn("pnpm", ["--filter", app.filter, "dev"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const tag = `${app.color}[${app.name}]\x1b[0m`;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    let rest = "";
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      // 最后一段可能是半行，留到下一块数据再拼
      rest = lines.pop() ?? "";
      for (const line of lines) {
        console.log(`${tag} ${line}`);
      }
    });
  }

  child.on("exit", (code) => {
    console.log(`${tag} 已退出（code=${code}）`);
    stopAll();
  });

  children.push(child);
}

function stopAll() {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, stopAll);
}
