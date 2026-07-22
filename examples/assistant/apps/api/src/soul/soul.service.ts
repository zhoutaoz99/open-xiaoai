import { Inject, Injectable } from "@nestjs/common";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { nowISO } from "../memory/memory.types";
import { buildSystemPrompt, kSoulTemplate } from "../prompts";
import { SOUL_CONFIG, type SoulConfig, type SoulDocument } from "./soul.types";

/**
 * 灵魂与画像：装载、热更新、静态区拼装
 *
 * 注意：整个系统里只剩这两份文件了——记忆库和对话轮次都进了 Postgres。
 * 它们留在文件里是刻意的：灵魂和画像是给人看、给人改的，一个编辑器就能改，
 * 存盘下一句话就生效（按 mtime 热加载）。前台的编辑器改的也是同一份文件，
 * 不是另一套真相。
 */
@Injectable()
export class SoulService {
  private soul: CachedFile;
  private profile: CachedFile;

  constructor(@Inject(SOUL_CONFIG) private config: SoulConfig) {
    this.soul = new CachedFile(config.soulFile);
    this.profile = new CachedFile(config.profileFile);
  }

  /**
   * 首次启动时生成灵魂模板
   */
  init() {
    const { soulFile } = this.config;
    if (existsSync(soulFile)) {
      return;
    }
    mkdirSync(dirname(soulFile), { recursive: true });
    writeFileSync(soulFile, kSoulTemplate, "utf8");
    console.log(`✨ 已生成灵魂模板：${soulFile}（改它就能换人格）`);
  }

  /**
   * 画像全文，没有画像时返回空串
   */
  profileText(): string {
    return this.profile.read();
  }

  soulText(): string {
    return this.soul.read() || kSoulTemplate;
  }

  soulDocument(): SoulDocument {
    return this.soul.document();
  }

  profileDocument(): SoulDocument {
    return { ...this.profile.document(), maxChars: this.config.profileMaxChars };
  }

  /**
   * 写灵魂（只有人能调到这里：前台的编辑器，或者直接改文件）
   *
   * 注意：系统自己永远不会调它。助手不该悄悄改变自己的性格——
   * 这是主人的权利。
   */
  writeSoul(text: string) {
    atomicWrite(this.config.soulFile, text);
    console.log(`✨ 灵魂已更新：${this.config.soulFile}（${text.length} 字）`);
  }

  /**
   * 写画像
   *
   * 注意：两个写者——定时巩固任务，和前台的编辑器。改之前先备份，
   * 巩固的提示词也要求保留没被新证据推翻的人工内容。
   */
  writeProfile(text: string) {
    this.backupProfile();
    atomicWrite(this.config.profileFile, text);
  }

  /**
   * 把画像备份成同目录的 *-<时间戳>.bak
   *
   * @returns 备份文件路径；原文件不存在时返回 undefined
   */
  backupProfile(): string | undefined {
    const file = this.config.profileFile;
    if (!existsSync(file)) {
      return undefined;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(dirname(file), `${basename(file)}-${stamp}.bak`);
    copyFileSync(file, target);
    return target;
  }

  removeProfile() {
    rmSync(this.config.profileFile, { force: true });
  }

  /**
   * 拼装系统提示词（静态区）
   *
   * 注意：这一段天级才变，`system + 历史` 前缀稳定，对前缀缓存友好
   */
  systemPrompt(tools?: string): string {
    return buildSystemPrompt({
      soul: this.soulText(),
      profile: this.profileText() || undefined,
      tools,
    });
  }
}

/**
 * 原子写：先写临时文件再 rename
 *
 * 注意：直接写目标文件的话，写到一半崩溃会留下半截内容。
 * 灵魂被截断意味着助手下一句话就人格错乱了。
 */
function atomicWrite(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${text.trim()}\n`, "utf8");
  renameSync(tmp, file);
}

/**
 * 按 mtime 缓存的文本文件：改文件下一句话就生效，无需重启
 *
 * 注意：每请求一次 stat()，微秒级，比起热更新的价值不值一提
 */
class CachedFile {
  private cache?: { mtimeMs: number; text: string };

  constructor(private file: string) {}

  read(): string {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.file).mtimeMs;
    } catch (_) {
      this.cache = undefined;
      return "";
    }
    if (this.cache?.mtimeMs !== mtimeMs) {
      try {
        this.cache = { mtimeMs, text: readFileSync(this.file, "utf8").trim() };
      } catch (e) {
        console.error(`❌ 读取 ${this.file} 失败`, e);
        return this.cache?.text ?? "";
      }
    }
    return this.cache.text;
  }

  document(): SoulDocument {
    const text = this.read();
    let updatedAt: string | null = null;
    try {
      updatedAt = nowISO(statSync(this.file).mtime);
    } catch (_) {
      // 文件还不存在，updatedAt 留 null
    }
    return { path: this.file, text, updatedAt, chars: text.length };
  }
}


