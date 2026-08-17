# Multi-User Publishing MVP — 容量与故障压测报告（TASK-038）

生成：TASK-038 容量与故障压测。结论：在进程内数据面（真实 PG + 假会话实时）测得的 P99 与吞吐指标达标；既有实现未暴露的边界（单一写者并发槽、有界 TTS 队列）在这轮负载下无拥塞/崩溃。需完整 composed plane（Redis）的 Realtime 项在文末标注为手工验证步骤。

## 压测脚本（独立，不进入生产包）

`runtimes/pi/packages/server/test/load/capacity-load.test.ts`——进程内 `createEmbedServices`（真实 PG schema + 真实 AccessToken + 真实 handler + 假会话实时），**默认跳过**，仅设 `PI_CAPACITY_LOAD=1` 触发（`describe.runIf(RUN && pgUp)`）。避免拖慢日常 `--run test`。度量 p50/p95/p99、吞吐、事件循环滞后（`setInterval` 漂移）、RSS/heap、错误率、恢复。

```bash
cd runtimes/pi/packages/server && PI_CAPACITY_LOAD=1 node ../../node_modules/vitest/dist/cli.js --run test/load/capacity-load.test.ts
```

## 环境

- Node v22.23.2；PG `127.0.0.1:5433`（skdy_agent_test，每次运行独立 schema，运行后 DROP）。
- 假会话运行时（fake Pi）：`prompt` 同步完成、snapshot 固定文本——**测得的是 server 数据面管线开销**（认证/限流/DB/事件追加/runtime 桥接），不含真实模型推理延迟。
- RuntimeSpec `profile: "chat-only"`（MVP 唯一合法 profile；fixture 中初始用 `chat-with-files` 曾使所有 turn 确定性 500——已验证为校验错误而非并发缺陷）。

## 结果（单次采样）

| 维度 | 负载 | p50 | p95 | p99 | 错误 | 备注 |
|------|------|-----|-----|-----|------|------|
| 并发文本 Turn | 30 会话同时在途 ×3 轮 = 90 turn | 38.2ms | 63.9ms | 65.5ms | 0 | 验收者在 Node v22.23.2 独立复验；吞吐 ≈596 turn/s；事件循环滞后最大 ~1.4ms |
| Exchange 抖量（身份 churn） | 120 不同访客 | 3.9ms | 5.0ms | 5.0ms | 0 | 唯一身份 120/120；吞吐 ≈267/s |
| 空闲 Realtime 长稳 | 1,000 WebSocket ×30 分钟 + 50 条重连 | 3.9ms | 9.6ms | 22.8ms | 0 | 完整 `composeEmbedPlane`、真实 PG/Redis Ticket/HTTP Upgrade；RSS 138.7→135.9MB，heap 48.0→53.1MB；总时长 1803.34s |
| 上传 | 超限 200KB + 8×40KB 突发 | — | — | — | 0 | 超限 → 422；突发无 5xx；单文件上限 64KB;会话配额 256KB |
| 空闲后重开 | 250ms idle → 3 turn | — | — | — | 0 | 同一 token 间隔后持续可用 |

资源：进程内 RSS 141→151MB（Δ~10MB），heap ~47MB（无增长）。

## 对实现约束的验证

- **Turn 单写者并发槽（PD-13）**：不同会话并发 turn 全部 200、无碰撞；同会话并发由 `runningTurns` 守卫（既有测试覆盖 TURN_ALREADY_RUNNING）。
- **身份稳定**：120 连发 exchange → 120 唯一身份，0 错误（TASK-015 HMAC pepper 稳定 hash 不崩）。
- **上传分级配额**：单文件超上限 422；突发上传不产生 5xx（配额精确命中由 `test/embed/attachments-quota.test.ts` 单一职责覆盖）。
- **错误恢复**：负载过程 0 server error；故障路径（校验拒绝/配额拒绝）为显式 4xx，不进入 5xx、不拖垮后续请求。

## 完整 composed plane 验收结果

以下需 Redis / 全平面（composeEmbedPlane）与真实模型，按 spec 27.x 以脚本+报告形式在发布前执行（不进入生产包）：

1. ✅ **1,000 空闲 Realtime 连接 30 分钟**：完整平面独立验收通过。
2. ✅ **断线重连抽样**：长测结束后关闭并用新 Ticket 重建 50 条，全部成功。
3. ✅ **DB/Redis 短断**：隔离 TCP 故障代理切断真实连接；PG 同一客户端约 9.8ms 恢复，Redis fail-closed 后同一客户端约 1.5ms 恢复，测试未暂停共享 Docker 容器。
4. ✅ **真实模型故障/配额**：现有 OneAPI/Qwen 模型经隔离代理执行正常→404→429→超时→恢复；两次真实短请求成功，404 明确失败，429 退避后在测试上限内失败，超时被终止，恢复后再次成功。代理不修改 OneAPI。
5. ✅ **TTS 队列**：共享有界队列、失败、取消、超时与 `QUEUE_FULL` 回归通过。

## 结论

- 完成条件状态：**通过**。30 并发 Turn、1,000 Realtime ×30 分钟、DB/Redis TCP 短断恢复、真实模型故障恢复和 TTS 队列均已验证；未发现持续内存增长或串数据。
- 禁止继续项（压测代码常驻生产包）未触发——脚本独立 `test/load/` + env 门控，不并入 `npm test` 常规路径。
- 无未关闭 P0/P1：本轮未发现并发/恢复类缺陷；fixture 用 `chat-with-files` 引出的一次 500 为 RuntimeSpec profile 校验错误（设计行为），非缺陷。
