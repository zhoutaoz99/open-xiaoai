# 项目骨架模板

> **与业务无关**的全栈脚手架，用作起新项目的模板。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 后端 | NestJS 11（TypeScript 5.9，CommonJS/ES2022） |
| 前端 | Next.js 16（App Router）+ React 19 |
| 存储 | PostgreSQL 16 + Redis 7（会话/缓存） |
| 工程 | npm workspaces monorepo |

## 目录结构

```text
<root>/
├── package.json            # workspaces:["apps/*"] + 顶层 scripts(dev/build/start)
├── .env.example            # 环境变量清单
├── <secrets>.example.json  # 结构化密钥模板(真实文件进 .gitignore)
├── scripts/dev.mjs         # 并行拉起前后端的开发脚本
├── apps/api/               # NestJS 后端
│   ├── tsconfig.json / nest-cli.json
│   └── src/
│       ├── main.ts app.module.ts app.controller.ts
│       ├── data/           # 全局:postgres.service + redis-cache.service
│       └── <feature>/      # 每个业务域一目录:module/controller/service/repository/types
└── apps/web/               # Next.js 前端
    ├── next.config.ts      # turbopack root(monorepo 必需)
    └── app/
        ├── layout.tsx      # 挂全局 Provider(如 Auth)
        ├── lib/            # 跨页共享:Provider、客户端、类型
        ├── components/     # 复用 UI
        └── <route>/page.tsx  # 页面(动态段用 [id])
```

## 核心约定

- **Monorepo**：前后端各自 `package.json`，根用 workspaces 统一编排。
- **后端按业务域纵切**：每域一个目录，固定 `module/controller/service/types`（要数据访问加 `repository`）；DI 靠 NestJS 模块 `imports/exports` 显式连接。
- **数据层 `@Global()`**：`data` 模块全局导出，各特性无需重复 import 即可注入 PG/Redis。
- **无迁移工具**：建表用 `CREATE TABLE IF NOT EXISTS` 写在 `postgres.service.ts` 的 `migrate()`，随启动自愈。
- **数据存储**：查询/关联字段建真列，整块状态塞 `jsonb payload`（演进快、免迁移）。
- **引导顺序**：`main.ts` 里 `dotenv` 必须在其它 import 前执行；`listen` 绑 `0.0.0.0` 以支持局域网/外部访问。
- **密钥分流**：`NEXT_PUBLIC_*` 才进浏览器；结构化第三方凭据走独立 `<secrets>.json`（不塞 `.env`）。
- **前后端类型镜像**：前端 `lib/*-types.ts` 与后端 `*.types.ts` 手动对齐。

## 快速搭建

```bash
mkdir -p <p>/apps/api/src/data <p>/apps/web/app/lib <p>/scripts <p>/docs && cd <p> && git init
# 1) 根 package.json 设 workspaces + scripts
# 2) 后端
npm i -w apps/api @nestjs/common @nestjs/core @nestjs/platform-express \
  pg redis dotenv reflect-metadata rxjs
npm i -w apps/api -D @nestjs/cli @types/node @types/pg typescript
# 写 tsconfig/nest-cli、main.ts、app.module.ts、data/ 三件套
# 3) 前端
npx create-next-app@latest apps/web --ts --app --no-tailwind --no-src-dir --no-eslint
# next.config 设 turbopack root;layout 挂 Provider
# 4) 起存储
docker run -d --name <p>-pg -e POSTGRES_DB=<db> -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
docker run -d --name <p>-redis -p 6379:6379 redis:7-alpine
# 5) 跑
npm install && npm run dev        # web:3000 / api:3001
```

**加后端模块**：建 `src/<feature>/` 四件套 → service 注入 PG/Redis → 新表加进 `migrate()` → `app.module.ts` 挂上。
**加前端页面**：建 `app/<route>/page.tsx` → 共享态放 `lib/`、UI 放 `components/` → 类型与后端对齐。
