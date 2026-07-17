import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nowISO } from "./types.js";

export interface TranscriptEntry {
  ts: string;
  session_id: string;
  user: string;
  assistant: string;
}

/**
 * 对话流水：每轮问答追加一行 JSON
 *
 * 存在的唯一目的是给定时巩固当原料——尤其是模式挖掘：
 * 单次"问天气"太琐碎，抽取器按防污染原则不记，
 * "每天早上都问天气"这个模式只有流水里挖得出来。
 */
export class Transcript {
  constructor(
    private file: string,
    /**
     * 保留天数，0 表示不落流水（牺牲模式挖掘）
     */
    private days: number
  ) {}

  get enabled() {
    return this.days > 0;
  }

  append(sessionId: string, user: string, assistant: string) {
    if (!this.enabled) {
      return;
    }
    const entry: TranscriptEntry = {
      ts: nowISO(),
      session_id: sessionId,
      user,
      assistant,
    };
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf8");
  }

  /**
   * 读取保留期内的流水
   *
   * 注意：坏行直接跳过。流水是追加写的，崩溃可能留下半行，
   * 不值得为此让整个巩固任务失败。
   */
  read(): TranscriptEntry[] {
    if (!existsSync(this.file)) {
      return [];
    }
    const deadline = Date.now() - this.days * 24 * 60 * 60 * 1000;
    const entries: TranscriptEntry[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        if (new Date(entry.ts).getTime() >= deadline) {
          entries.push(entry);
        }
      } catch (_) {
        continue;
      }
    }
    return entries;
  }

  /**
   * 清理过期流水，防止文件无限增长
   *
   * 注意：配成 0（不落流水）时把已有的流水一并删掉——
   * 用户关掉它就是不想让对话原文留在磁盘上，留着旧文件等于没关
   */
  prune() {
    if (!existsSync(this.file)) {
      return;
    }
    if (!this.enabled) {
      rmSync(this.file, { force: true });
      return;
    }
    const text = this.read()
      .map((e) => `${JSON.stringify(e)}\n`)
      .join("");
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, this.file);
  }
}
