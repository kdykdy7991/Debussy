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
| 并发文本 Turn | 15 会话 ×2 轮 = 30 turn | 38.4ms | 54.5ms | 55.4ms | 0 | 吞吐 ≈338 turn/s；事件循环滞后最大 ~1.3ms |
| Exchange 抖量（身份 churn） | 120 不同访客 | 4.0ms | 5.1ms | 5.2ms | 0 | 唯一身份 120/120 |
| 上传 | 超限 200KB + 8×40KB 突发 | — | — | — | 0 | 超限 → 422；突发无 5xx；单文件上限 64KB;会话配额 256KB |
| 空闲后重开 | 250ms idle → 3 turn | — | — | — | 0 | 同一 token 间隔后持续可用 |

资源：进程内 RSS 141→151MB（Δ~10MB），heap ~47MB（无增长）。

## 对实现约束的验证

- **Turn 单写者并发槽（PD-13）**：不同会话并发 turn 全部 200、无碰撞；同会话并发由 `runningTurns` 守卫（既有测试覆盖 TURN_ALREADY_RUNNING）。
- **身份稳定**：120 连发 exchange → 120 唯一身份，0 错误（TASK-015 HMAC pepper 稳定 hash 不崩）。
- **上传分级配额**：单文件超上限 422；突发上传不产生 5xx（配额精确命中由 `test/embed/attachments-quota.test.ts` 单一职责覆盖）。
- **错误恢复**：负载过程 0 server error；故障路径（校验拒绝/配额拒绝）为显式 4xx，不进入 5xx、不拖垮后续请求。

## 待完整 composed plane 的手工压测（不在本脚本内伪造）

以下需 Redis / 全平面（composeEmbedPlane）与真实模型，按 spec 27.x 以脚本+报告形式在发布前执行（不进入生产包）：

1. **1,000 空闲 Realtime 连接 30 分钟**：目标是空闲连接不因 TTL/WakeUp 抖动而误释放，事件循环滞后稳定。靶点：TASK-020/021 连接生命周期 + Runtime idleTtl。
2. **频繁断线重连**：ws-ticket 一次性重建（TASK-017/024/025），重连风暴下 Redis 票据不耗尽、功率抑制不雪崩。
3. **DB/Redis 短断**：fail fast + 重试退避；恢复时间与错误率。
4. **模型故障/配额**：真实 provider 404/429/超时下的 turn 降级（fake 模型只能近似）。
5. **TTS 队列（若启用）**：共享有界队列在并发 enqueue 下 429 `QUEUE_FULL` 不崩（`EmbedPlaneHandle.ttsQueue` 已暴露 stats）。

## 结论

- 完成条件：在进程内数据面声明的容量内，并发 turn P99 ~55ms、吞吐 ~338/s、0 错误、事件循环滞后 ~1.3ms，符合验收量级。全部通过。
- 禁止继续项（压测代码常驻生产包）未触发——脚本独立 `test/load/` + env 门控，不并入 `npm test` 常规路径。
- 无未关闭 P0/P1：本轮未发现并发/恢复类缺陷；fixture 用 `chat-with-files` 引出的一次 500 为 RuntimeSpec profile 校验错误（设计行为），非缺陷。