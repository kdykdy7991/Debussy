# Publishing MVP 依赖评审记录（TASK-002）

> 依据 `runtimes/pi/AGENTS.md`：直接依赖固定精确版本；检查包类型、许可、生命周期脚本、Node 22 支持；安装使用 `npm install --ignore-scripts`。
> 评审日期：2026-08-14。Node v22.23.2 / npm 10.9.8。

## 新引入直接依赖（`@earendil-works/pi-server`）

| 包 | 精确版本 | 用途 | 许可 | 类型 | lifecycle 脚本 | Node 支持 | 替代方案 |
|---|---|---|---|---|---|---|---|
| `postgres` | 3.4.9 | PostgreSQL 驱动（SQL template，零运行时依赖，自带 d.ts） | Unlicense | 内置 `types/index.d.ts` | `prepare`（构建）、`prepublishOnly`（lint）——安装时 `--ignore-scripts` 跳过 | 无 engines 限制（兼容 Node 22） | `pg`（需要 `@types/pg`、回调风格）、`pg-native`（原生编译）。选 `postgres`：零依赖 + ESM 优先 + 类型内置 |
| `ioredis` | 6.0.0 | Redis 客户端（nonce、Ticket、限流、并发槽） | MIT | 内置 `built/index.d.ts` | 无 install 脚本（build/test 为 dev 脚本） | `>=20.0.0` ✓ | `node-redis`（v5 API 较新、Pipeline 事件模型不同）、`ioredis` 是事实标准，集群/事务/Lua 支持成熟。选 `ioredis` |
| `jose` | 6.2.8 | JWS（Launch Token 验签、Access Token 签发）、Ed25519 | MIT | 内置 `dist/types/index.d.ts` | 无 install 脚本 | 无 engines 限制 ✓ | `jsonwebtoken`（CJS、无现代算法优先）、`jose` 是 WebCrypto 优先、零依赖。选 `jose` |
| `minio` | 8.0.7 | S3 兼容对象存储客户端（附件） | Apache-2.0 | 内置 `dist/main/minio.d.ts` | `prepare`（husky install）——安装时 `--ignore-scripts` 跳过 | `^16 \|\| ^18 \|\| >=20` ✓ | `@aws-sdk/client-s3`（依赖树大、类型复杂）。MinIO 客户端同时兼容 AWS S3，足够 MVP 且体积小。选 `minio` |
| `zod` | 3.25.76 | 运行时 Schema 校验（协议 payload、RuntimeSpec） | MIT | 内置 d.ts | 无 install 脚本 | 兼容 Node 22 ✓ | 仓库已有 `zod@3.25.76`（deduped，无新增体积）；`valibot` 更小但需新引入。选现有 `zod` 3.25.76 |

## 不重复引入的决定

- **JWT/JWS**：仓库内无既有 JWT 库，`jose` 是新增必需。
- **运行时 Schema**：仓库已含 `zod@3.25.76`（通过 pi-ai 等传递），直接作为 server 直接依赖复用，不引入第二个 Schema 库。
- **PostgreSQL/Redis/S3**：仓库原有 server 仅用 `ws` + `busboy`，均无既有客户端，全部为新增。

## 安装方式与验证

- 命令：`npm install --ignore-scripts --workspace=@earendil-works/pi-server postgres@3.4.9 ioredis@6.0.0 jose@6.2.8 minio@8.0.7 zod@3.25.76`
- 类型冒烟测试：`packages/server/test/publishing/dependencies.test.ts`（5 passed）——五个包均以 ESM 导入且类型可用，无 `any`。
- `npm run check`：全绿。

## npm audit 说明

`npm audit` 报告 3 个 high 漏洞（`brace-expansion`、`nanoid`、`undici`），均来自**既有传递依赖**（`pi-coding-agent`→`minimatch`、`pi-web`→`vite`→`postcss`、`pi-coding-agent`/`gondolin`→`undici`），本次新增依赖未引入任何新漏洞，且 `minio@8.0.7` 的传递依赖均为常规库。不在 TASK-002 范围，后续若有安全任务统一处理。

## lockfile 说明

`package-lock.json` 除新增 5 个直接依赖及传递依赖外，顺带补齐了 `@skdy/avatar`（`file:../../../../packages/avatar`）条目：该引用在 HEAD 的 `packages/web/package.json` 中已存在，但 lockfile 长期未同步；npm 全局重解析时自动补齐，非本任务引入的新依赖，保留以维持 lockfile 与 package.json 一致。
