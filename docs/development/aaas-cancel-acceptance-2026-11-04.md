# AaaS 取消专项验收（2026-11-04）

结论：隔离环境中，真实 Qwen、真实 Agent Runtime 和可控 MCP HTTP 服务的取消链路通过；真实工单 Integration 的正常只读回归尚未完成，不标记生产验收通过。

## 验证结果

| 场景 | 结果与证据 |
| --- | --- |
| 排队取消 | Run 在启动独立 Dispatcher 进程前取消；启动后没有开始执行，`started_at` 仍为空。 |
| Qwen 执行中取消 | 独立进程运行真实 CodingAgent Runtime，观察到 Qwen HTTP 请求后，由 API 进程发起取消；请求 AbortSignal 触发，Runtime dispose，结果为空。 |
| MCP 执行中取消 | 真实 Qwen 调用本地可控 MCP HTTP 工具；工具开始后由另一进程取消，工具 AbortSignal 及服务端请求信号均触发，Runtime dispose。测试服务显式将 HTTP 连接断开传播至服务端请求。 |
| Runtime 启动竞态 | 受控延迟 Runtime 打开，在打开期间标记取消，释放打开流程后确认 prompt 未执行。 |
| 迟到结果 | 跨进程受控执行器在取消后返回迟到结果，Run 保持 cancelled，result 为 null。 |
| 重复取消与恢复 | 重复取消保持 cancelled；取消后启动 Dispatcher 未重新领取该任务。尚未模拟运行进程崩溃重启期间的所有异常。 |
| 正常执行 | 隔离 Integration 使用真实 Qwen 和可控 MCP，在前一个 Run 取消后新建 Run，工具实际调用且 completed 返回非空结果。并非真实工单 Integration。 |
| 0027 → 0028 | 隔离 PostgreSQL 逐步迁移，比较迁移前后所有 WorkItem 字段、结果与请求 hash；新增字段为 null，重复迁移无操作。 |

测试入口：`packages/server/test/orchestration/integration.test.ts`、`configuration-migration.test.ts`、`conversation-executor.test.ts` 与 `packages/server/test/publishing/mcp-sdk-prototype.test.ts`。真实模型测试以 `PI_AAAS_QWEN_ACCEPTANCE=1` 显式启用，使用本机配置的 oneapi/Qwen；普通测试不会触发真实模型请求。

工具端中断结论仅适用于本次可控、支持请求断开信号的 MCP 服务。其他服务或工具可能不支持中断，取消也不能撤销已经发生的外部副作用。

真实工单端的 Integration Token 和工具任务授权此前只保存在临时联调进程，当前未取得；既有工单 Integration 的 POST → Qwen → 实际工单 MCP → completed 回归仍待持有有效授权的环境执行。
