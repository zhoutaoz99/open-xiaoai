import { BadRequestException, Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../api-key.guard";
import { SoulService } from "./soul.service";

interface WriteBody {
  text?: unknown;
}

/**
 * 灵魂与画像的读写，给前台的编辑器用
 *
 * 注意：改的就是 data/ 下那两份 Markdown 文件本身，不是另一套真相——
 * 你用 vim 改和在前台改，是同一个文件、同样立刻生效。
 */
@Controller()
@UseGuards(ApiKeyGuard)
export class SoulController {
  constructor(private soul: SoulService) {}

  @Get("soul")
  getSoul() {
    return this.soul.soulDocument();
  }

  /**
   * 写灵魂
   *
   * 注意：不做内容校验，这是主人的地盘。只挡空文件——
   * 灵魂被清空意味着助手下一句话就没人格了，那多半是误操作
   * （编辑器里全选删掉再点保存）。
   */
  @Put("soul")
  putSoul(@Body() body: WriteBody) {
    const text = readText(body);
    this.soul.writeSoul(text);
    return this.soul.soulDocument();
  }

  @Get("profile")
  getProfile() {
    return this.soul.profileDocument();
  }

  /**
   * 写画像
   *
   * 注意：写之前会自动备份成 *.bak。画像还有一个写者是定时巩固任务，
   * 它的提示词要求保留没被新证据推翻的人工内容——所以这里手写的东西
   * 不会在下一次巩固时被抹掉。
   */
  @Put("profile")
  putProfile(@Body() body: WriteBody) {
    const text = readText(body);
    this.soul.writeProfile(text);
    return this.soul.profileDocument();
  }
}

function readText(body: WriteBody): string {
  if (typeof body?.text !== "string") {
    throw new BadRequestException("text 必须是字符串");
  }
  const text = body.text.trim();
  if (!text) {
    throw new BadRequestException("内容不能为空");
  }
  return text;
}
