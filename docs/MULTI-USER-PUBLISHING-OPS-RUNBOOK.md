# Multi-User Publishing MVP — 运维 Runbook（TASK-039）

面向运维：部署全平面、以及**撤回一次发布/停用受影响 App**的标准化步骤。完成条件锚定 spec §20 DoD：运维人员能按本 runbook 撤回发布，且不存在只能改数据库才能恢复的运营操作。所有恢复动作都走**控制面 HTTP 或环境重启**，不贴库。

## 0. 配置契约（`docs/mvp.env.example` 为模板）

| 环境变量 | 含义 | 来源 |
|---|---|---|
| `PI_PUBLISHING_ENABLED=true` | 主开关（false=不建发布链路） | `config.ts` |
| `PI_DATABASE_URL` | PG（多用户写入） | 必填（enabled） |
| `PI_REDIS_URL` | Redis（限流/Ticket/幂等；Embed 数据面要求） | 必填（enabled，compose 层面） |
| `PI_BOOTSTRAP_TENANT_ID/NAME` | 内部管理员租户（控制面映射目标） | 必填 |
| `PI_CONTROL_ADMIN_TOKEN_FILE` | 管理员令牌文件（≥32 字符、恒定时间比较、不入日志） | 必填 |
| `PI_EMBED_SUBJECT_PEPPER` | 匿名身份 HMAC 密钥（泄漏=可推导匿名身份，须妥善保管/轮换） | 必填 |
| `PI_EMBED_ACCESS_TOKEN_{PRIVATE,PUBLIC}_KEY_FILE` / `_KEY_ID` | Embed Access Token Ed25519 签名密钥 + kid | 必填 |
| `PI_EMBED_ACCESS_TOKEN_TTL_SECONDS` | 默认 600 | 选填 |
| `PI_EMBED_ISSUER` | JWT iss | 选填 |
| `PI_EMBED_LAUNCH_TOKEN_AUDIENCE/ALLOWED_ISSUERS` | signed-user 校验 | PD-19 默认关闭 |
| `PI_OBJECT_STORE_{ENDPOINT,REGION,BUCKET,ACCESS_KEY_ID,SECRET_ACCESS_KEY}` | S3 兼容附件对象存储；缺省 → 上传 503（不静默降级到磁盘） | 附件启用必须 |
| `PI_EMBED_UPLOAD_QUOTA_{CONVERSATION,PRINCIPAL,APP}_BYTES` | 三级上传配额（默认 100MB/500MB/2GB） | 选填 |

> 密钥类（pepper/Embed 私钥/admin token）以**文件路径**注入、经容器 secret 挂载，不写环境变量明文、不写日志（TASK-035 脱敏）。

## 1. 部署（compose 全平面）

```
POST 平面由 server 进程同时挂载：
  控制面   POST /api/control/v1/*               Authorization: Bearer <admin token>
  数据面   /api/embed/v1/*                      匿名/signed-user 公开端点 + 真实 HTTP
  web      Embed 壳（dev 调试）与宿主 iframe 引入
```

1. 起 PG + Redis（多节点时共享）。
2. 注入 `docs/mvp.env.example`（展开 secret 挂载）。
3. server 启动首跑自动执行 migration（最新 000x）；`PI_BOOTSTRAP_TENANT_ID` 幂等创建管理员租户。
4. 校验：
   - `GET /api/embed/v1/bootstrap?publicAppId=<id>` → 200（feature/theme/origins）。
   - 控制面按 §2 建 App、传版本、activate。
   - 数据面 exchange → 建会话 → turn/上传 → 200。

## 2. 撤回发布 / 停用 runbook（免贴库）

所有操作带幂等键（`Idempotency-Key`）与 `Authorization: Bearer <admin-token>`，返回统一错误信封。

| 场景 | 操作 | 效果 | 效果时间 |
|---|---|---|---|
| 版本回滚到上一 ready 版 | `POST /api/control/v1/published-apps/:id/rollback` | 指针回指上一 ready 版本；历史 spec 不变；审计 `app.rollback` | 立即（新会话用旧版本） |
| 整体停用受影响 App（最硬） | `POST /api/control/v1/published-apps/:id/suspend` | App status→suspended；再 exchange/建会话/上传 → 403 `APP_SUSPENDED`；审计 `app.suspend` | 立即阻断新的数据面操作 |
| 重新启用 | `POST /api/control/v1/published-apps/:id/activate` | 恢复 active；指针指当前版本 | 立即 |
| 吊销 Launch Key / 关闭 signed-user | `POST /api/control/v1/published-apps/:id/launch-keys/:kid/revoke` | signed_user 请求用被吊销 key → 拒绝；匿名不受影响 | 立即 |
| 且/或整体关闭 signed-user | 不配 `PI_EMBED_LAUNCH_TOKEN_ALLOWED_ISSUERS`（PD-19 默认关闭）→ signed_user 显式 403 | 无需改代码 | 重启生效 |
| 关闭某项能力（上传/TTS/Avatar） | 发布不含该 capability 的版本并 `activate`（能力随版本 RuntimeSpec 变化） | 上传/TTS/avatar 按新版本门控 | 新会话生效 |

### 2.1 快速停用（生产事故最高优先）
```bash
curl -X POST http://<plane>/api/control/v1/published-apps/<publicAppId>/suspend \
  -H "Authorization: Bearer $(cat /run/secrets/control-admin-token)" \
  -H "Idempotency-Key: incident-$TS"
# 期望 200 + audit app.suspend；受影响 App 的所有数据面新操作立即 403 APP_SUSPENDED
```

### 2.2 撤回一次发布（只回滚新版本，保留旧版在线）
```bash
curl -X POST http://<plane>/api/control/v1/published-apps/<publicAppId>/rollback \
  -H "Authorization: Bearer $(cat /run/secrets/control-admin-token)" \
  -H "Idempotency-Key: rollback-$TS"
# 期望 200 + audit app.rollback（metadata 含 versionId/previousVersionId）
```

### 2.3 Access Token / 身份密钥轮换（重启式吊销）
1. 生成新 Ed25519 密钥对 + `kid`；更新 `PI_EMBED_SUBJECT_PEPPER` 与两把 key 文件。
2. 滚动重启 server：新 token 用新密钥签发；旧 token 因密钥/kid 不匹配在 verify 时 `401 TOKEN_INVALID`，客户端按 `AUTH_EXPIRED` 重走 Exchange 自动续期。

## 3. Runtime drain / 优雅停服
`composeEmbedPlane().close()` = `runtimeManager.drain()`（空闲/活跃 Runtime 释放）+ `redis.close()` + `objectStore.close()`：停服先 drain 再退出，避免孤儿会话；持久事件保证重启后会话可从历史恢复（TASK-021/022）。

## 4. 故障与降级矩阵
| 故障 | 用户可感知 | 处置 |
|---|---|---|
| PG 短暂断 | Exchange/上传/Turn 5xx(重试) | 自动重试/退避（流量限流防雪崩）；恢复即回 |
| Redis 断 | Ticket/限流/幂等不可用（数据面需 Redis） | fail-closed；恢复后 ws-ticket 重建 |
| TTS provider 断 | TTS POST 503 `TTS_UNAVAILABLE`；文本 turn 不受影响 | 文本链路独立（TASK-036），只语音受影响 |
| 对象存储断 | 上传 503；已有附件读照常 | 不落本地伪造；恢复即回（TASK-030/031） |
| 模型 429/超时 | turn 失败重试 | turnout 退避；并发槽（PD-13）防雪崩 |

## 5. 禁止项核对
- ❌ 只改数据库才能恢复的运营操作：不含（全部走控制面 HTTP）。
- ❌ 无法快速停用受影响 App：存在（suspend 一键阻断）。
- ❌ 凭据入库/入日志：pepper/令牌脱敏（TASK-035），密钥文件挂载不入 env 明文。