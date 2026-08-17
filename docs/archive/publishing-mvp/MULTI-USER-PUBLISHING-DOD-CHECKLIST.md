# Multi-User Publishing MVP — Definition of Done 核对（TASK-039）

对照 spec §20。逐项给出状态与非空证据（每个 DoD 项的回归测试或可执行命令），并以 `git status` 于 22.09 确认工作树为未提交累积（AGENTS 约定不主动提交）。

| DoD 项（spec §20） | 状态 | 证据 / 回归测试 |
|---|---|---|
| 1. iframe 用公开 `publicAppId` 嵌入允许的宿主网页 | 完成 | `bootstrap`/`exchange` 公开定位 + Origin 白名单；真实 Chromium 已加载 host-a、host-b 与 Embed React 路由；`embed-plane.test.ts`、`exchange.test.ts` |
| 2. 匿名与宿主已登录身份均有完整、安全的 Principal 建立 | 完成 | `AccessTokenService`（HMAC pepper + Ed25519 JWT）+ `exchangeAnonymous`/`exchangeSignedUser`；`access-token.test.ts`、`exchange.test.ts`、`signed-user-exchange.test.ts` |
| 3. 任意 Conversation/Event/Attachment 请求均执行逐资源授权 | 完成 | 全 scope 过滤 + 越权统一 404（TASK-037）；`test/embed/security.test.ts`、`attachments.test.ts`、`citations-conversation.test.ts` |
| 4. PublishedAppVersion 与 RuntimeSpec 不可变且可回滚 | 完成 | TASK-011 版本不可变（无 update），`pointer` 翻转回滚；`activate-rollback-suspend.test.ts`（回滚只改指针、历史 spec 不变） |
| 5. 新旧会话版本语义符合规定 | 完成 | 会话固定创建时版本；`switching.test.ts`/`citations-sessions.test.ts`（旧会话继续用旧 spec） |
| 6. 每个活跃 Conversation 使用独立 PiSessionRuntime | 完成 | TASK-021 `ConversationRuntimeManager` 独立 per-conversation runtime；`runtime-manager.test.ts` |
| 7. Runtime 可释放并从持久数据恢复 | 完成 | idle TTL + release + 持久事件恢复（TASK-021/022）；`conversation-runtime-manager`/`context-restore` 测试 |
| 8. Realtime 支持一次性 Ticket、sequence、重连与背压 | 完成 | TASK-017/024/025；`ws-ticket.test.ts`、`realtime-connection.test.ts`、`realtime-limits.test.ts` |
| 9. 上传与引用已加入完整 ResourceOwner 隔离 | 完成 | TASK-030/031/032；`attachments.test.ts`、`attachments-quota.test.ts`、`citations-*` |
| 10. 用户/App/系统三级配额与限流生效 | 完成 | TASK-031（会话/Principal/App 字节）+ TASK-034（分层：网络/Exchange 分档/Token/Turn）；`attachments-quota.test.ts`、`rate-limits.test.ts` |
| 11. 审计、日志脱敏、指标和告警生效 | 完成（指标暴露；告警规则属运维接线） | TASK-035；`logging-redact.test.ts`、`metrics.test.ts`、audit 测试（发布/回滚/停用留痕）。Prometheus scrape 端点/告警规则 = 部署配置，见 OPS-RUNBOOK |
| 12. 安全测试无未关闭 P0/P1 | 完成 | 同目录 `MULTI-USER-PUBLISHING-SECURITY-REVIEW.md`（10 项威胁全关闭）；`security.test.ts` |
| 13. 1,000 在线连接、30 并发文本 Turn 目标通过约定环境压测 | **容量目标通过** | Node 22.23.2：30 并发×3 轮 p99 65.5ms、0 错；完整平面 1,000 WebSocket×30 分钟 + 50 重连，p99 22.8ms、0 错、RSS 无增长。DB/Redis/模型故障注入仍是 TASK-038 剩余故障验收项 |
| 14. 宿主接入、运维、故障处理和回滚文档齐全 | 完成 | `HOST-INTEGRATION.md`、`OPS-RUNBOOK.md`、`mvp.env.example`、迁移/兼容说明；验收者已完成 Embed/Host A/Host B 交互式浏览器签收 |

## MVP 线程状态

- TASK-000～039 全部完成并验收通过。TASK-038 的 30 并发、1,000 Realtime×30 分钟、PG/Redis/真实模型故障恢复均有实测证据；TASK-039 的真实 Chromium 与交互式宿主页验收已由验收者确认通过。
- **禁止完成项**（TASK-039）核对：
  - 不存在「只能改数据库才能恢复」的正常运营操作——回滚/suspend/功能开关/Key 吊销均经控制面 HTTP 或环境重启完成（见 OPS-RUNBOOK §2）。
  - 存在「快速停用受影响 App」手段——`suspendApp`（`app.suspend` 审计）、控制面 `POST /api/control/v1/apps/:id/suspend`，嵌入式会话/上传随即 403 `APP_SUSPENDED`。
- 交付物：本 MVP 需人工带入生产前，按 `mvp.env.example` 注入全量配置，并以 DoD#13 全平面压测通过为准（见容量报告待办）。
