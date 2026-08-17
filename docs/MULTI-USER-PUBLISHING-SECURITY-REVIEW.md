# Multi-User Publishing MVP — 安全验收报告（TASK-037）

生成：TASK-037 安全验收阶段。范围：Embed 数据面（Exchange / Conversation / Attachment / dev-turn / TTS）与发布控制面的交叉边界、身份、Origin、上传、日志、禁用/管理员边界。

结论：**无未关闭 P0/P1**。所有发现均有回归测试锚点。以下逐项对照 TASK-037 威胁清单（spec 阶段 H）。

## 威胁清单 → 实现 与 回归测试

| # | 威胁 | 实现要点（src 位置） | 回归测试 | 状态 |
|---|------|---------------------|----------|------|
| 1 | Tenant/App/Principal 越权 | 所有数据面服务按 `tenantId + publishedAppId + principalId` 过滤；越权 → 统一 404（`CONVERSATION_NOT_FOUND`/`ATTACHMENT_NOT_FOUND`），刻意不区分「不存在」与「无权」（不做不存在性 oracle） | `test/embed/security.test.ts`（三重越权 404）；`conversations.test.ts`、`attachments.test.ts`、`citations-conversation.test.ts` | 关闭 P0 |
| 2 | ID 枚举 | 随机/他人 ID → 404（非 403/200）；畸形 ID 格式 → 400（纯格式错误，不泄存在性） | `security.test.ts`（random conv/attachment 枚举）；`prep <ID>` 各服务 | 关闭 P0 |
| 3 | Origin 绕过 | Exchange 校验 `Origin` 落在 app `allowedOrigins`；缺 Origin/非白名单 → 403 `ORIGIN_NOT_ALLOWED` | `security.test.ts`、`exchange.test.ts` | 关闭 P0 |
| 4 | Access Token 重放 | Access Token 为可验证绑定签发者/audience 的 JWT；Ticket 一次性消费；重放/篡改 → 401 | `access-token.test.ts`、`ws-ticket.test.ts`、`realtime-connection.test.ts` | 关闭 P1 |
| 5 | Launch Token / Ticket 重放 | Launch Token 带 nonce/一次性；nonce 并发复用只成功一次 | `signed-user-exchange.test.ts`、`ws-ticket.test.ts` | 关闭 P0 |
| 6 | nonce 并发 | 幂等/allocate 语义，同一 nonce 并发只落一次 | `signed-user-exchange.test.ts`、`control-service` idempotent | 关闭 P1 |
| 7 | 上传伪造 | `scanUpload` 校验 大小/扩展名/文件头/声明 MIME 交叉/可选 checksum；伪造 checksum 或 MIME 不匹配 → 422 `UPLOAD_REJECTED`；put 失败回滚对象存储，不留悬空/伪造文件 | `upload-scan.test.ts`、`security.test.ts`（伪造 checksum/MIME/跨身份上传） | 关闭 P0 |
| 8 | 日志泄漏 | `redact.ts`：URL query、Bearer token、已注册 secret（visitorId/externalUserId）不入日志；`createRedactingSink` | `logging-redact.test.ts` | 关闭 P0 |
| 9 | App suspend | 已签发 token 在会话/上传等数据面操作时按当前 app 状态校验 → 403 `APP_SUSPENDED`（PD-04，简单回滚） | `security.test.ts`（suspend 后旧 token 被拒）、`exchange.test.ts`、`control` suspendApp 测试 | 关闭 P0 |
| 10 | 管理员边界 | control admin 操作按 tenant scope 校验；跨租户资源 → 404；排产/发布/回滚/停用/密钥轮换均绑 scope | `control-service.test.ts` | 关闭 P1 |

## 联合验收动作（本阶段新增）

- **交叉边界矩阵**：`test/embed/security.test.ts`（真实 PG + 真实 AccessToken + 真实 handler，2 租户 / 3 app / 多访客），9 项：
  1. 同 app 跨访客、跨 app、跨租户读会话 → 统一 404
  2. 随机会话/附件 ID 枚举 → 404
  3. 跨身份读附件 → 404
  4. Origin 白名单外 / 缺失 → 403 `ORIGIN_NOT_ALLOWED`
  5. 伪造 checksum / 伪造 MIME → 422 `UPLOAD_REJECTED`
  6. 跨身份向他人会话上传 → 404
  7. Exchange 响应含 accessToken 但不回显 visitorId
  8. suspend 后旧 token 建会话 → 403 `APP_SUSPENDED`
  9. token 经同一服务可验证（身份 round-trip）

## 明确不进生产 / 提交阻断（禁止继续项，均不触发）

- 新增能力键（spec 5.5 冻结五键）——未做。
- 无 provider 时假装语音成功——TASK-036 为显式 503 `TTS_UNAVAILABLE`。
- 任何人可读取他人消息/附件、伪造身份、绕过 Origin —— 全部关闭。
- 身份作为无界 metrics label —— TASK-035 `FORBIDDEN` identity 标签策略阻断。

## 复现/验证

```bash
# 全量（含 security-*.test）：
cd runtimes/pi/packages/server && node ../../node_modules/vitest/dist/cli.js --run test
# 安全矩阵单独：
node ../../node_modules/vitest/dist/cli.js --run test/embed/security.test.ts
```

## 待办（非安全验收阻断，归入 TASK-038/后续）

- 真实 GPU TTS 后端接入后的音频拉流/回传路径未在验收范围（TASK-036 已知限制）。
- 无独立 `/metrics` scrape 端点（registry 已封装，运维接入属部署配置）。
- 管理操作审计与状态变更非单事务（fail-closed 但不同滚）——如需原子性并入后续事务化改造。
- 上传伪造的 FS 病毒扫描为占位（文件头/MIME 交叉 + checksum），真实 AV 引擎接入选型不做。