import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "templates");
const templates = new Map<string, string>();
let loaded = false;

function scan(base: string, prefix: string) {
  for (const entry of readdirSync(join(base, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      scan(base, rel);
    } else if (entry.name.endsWith(".txt")) {
      const name = rel.replace(/\.txt$/, "");
      templates.set(name, readFileSync(join(base, rel), "utf8").trimEnd());
    }
  }
}

function loadAll() {
  if (loaded) return;
  loaded = true;
  scan(dir, "");
}

/**
 * 加载并渲染提示词模板
 *
 * 模板按文件夹分用途，名字即相对路径（去 .txt），如 "extract/system-prompt"。
 *
 * 占位符语法：
 * - {{key}}            简单替换
 * - {{#if key}}...{{/if}}  key 非空时保留块内容，否则整块删除（支持嵌套）
 */
export function render(name: string, vars: Record<string, string> = {}): string {
  loadAll();
  const tpl = templates.get(name);
  if (tpl === undefined) {
    throw new Error(`模板不存在：${name}`);
  }
  // 从最内层开始逐层展开 {{#if}} 块
  const ifRe = /\{\{#if (\w+)\}\}((?:(?!\{\{#if\b)[\s\S])*?)\{\{\/if\}\}/g;
  let text = tpl;
  let prev: string;
  do {
    prev = text;
    text = text.replace(ifRe, (_, key: string, block: string) => (vars[key] ? block : ""));
  } while (text !== prev);
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}
