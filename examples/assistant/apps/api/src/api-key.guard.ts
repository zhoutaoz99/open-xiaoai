import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { kAssistantConfig } from "./config";

/**
 * Bearer 鉴权
 *
 * 注意：未配置 ASSISTANT_API_KEY 时不校验——这个服务大多跑在家里的内网，
 * 强制配密钥只会让人把它写进 git。启动时会打一条告警提醒。
 *
 * 前台不直接带这个 key：浏览器只访问前台自己的 /api/*，
 * 由前台的服务端代理转发时补上（见 apps/web/app/api/[...path]/route.ts），
 * 密钥不进浏览器。
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { apiKey } = kAssistantConfig.chat;
    if (!apiKey) {
      return true;
    }
    const req = context.switchToHttp().getRequest<Request>();
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      // 显式抛 401，而不是 return false——后者 Nest 会返回 403，
      // 而 v1 这里一直是 401。/chat 的协议连状态码都不该动
      throw new UnauthorizedException("unauthorized");
    }
    return true;
  }
}
