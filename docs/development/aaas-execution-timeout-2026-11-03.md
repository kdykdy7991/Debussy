# AaaS 两分钟超时诊断

状态：草案（只读诊断，未修改超时或中止实现）。创建日期：2026-11-03。

对象：`conv_879302a0-19db-4317-9bba-17ba1fa2f185`；Run `6d6a00a8-1cf9-4ff8-a65b-e9044dd0e3c3`；Assignment `20559043-f736-41bc-b43b-9c74c271a05f`。

## 事实与结论

实际任务状态为 failed，错误码 `EXECUTION_TIMEOUT`。Dispatcher 在执行前启动固定 `120_000` 毫秒计时器；到时标记 timedOut 并调用 abort，随后按超时落业务终态。该计时器目前不从冻结 RuntimeSpec 的 turnTimeoutMs 取值。

本次冻结版本为 `pav_01a19f44-cecc-7f5d-81d5-3c44f35f3738`，模型 oneapi/Qwen，reasoning.enabled=false，spec 的 turnTimeoutMs 也为 120000。任务 started_at 为北京时间 15:04:59.928，ended_at 为 15:06:59.954，间隔 120.026 秒，符合执行截止触发。

| 北京时间 | 持久事件 | 距上一关键阶段 |
| --- | --- | --- |
| 15:04:57.468 | 接受任务/创建上下文 | — |
| 15:04:59.945 | turn/start | 排队约 2.46 秒 |
| 15:05:56.729 | 首批 8 个 tool/call | 56.784 秒 |
| 15:05:57.235 | 首批最后一个 tool/result | 0.506 秒 |
| 15:06:34.991 | 第二批 5 个 tool/call | 37.756 秒 |
| 15:06:36.486 | 第二批最后一个 tool/result | 1.495 秒 |
| 15:06:59.940 | assistant/message，text 长度为 0 | 23.454 秒 |
| 15:06:59.947 | turn/end，ok=true | — |
| 15:06:59.954 | Assignment failed/EXECUTION_TIMEOUT | — |

13 次 MCP 调用审计 outcome 均为 success，单次 latency 99～1485 毫秒。此处 success 表示工具传输/调用完成，不等于每份业务数据都充分或有效。两批工具的墙钟等待总计约 2 秒，长间隔集中在工具前后模型请求阶段。现有事件无法继续拆分上游排队、模型推理、生成或网络等待，不能据此断言 GPU 性能或推理参数是根因。

## 独立记录的问题

1. 固定两分钟执行截止限制了多轮研判；后续如调整，应由冻结执行配置决定，保持平台上限，不能仅改浏览器等待时间。
2. 中止后内部写入空 assistant/message 与成功 turn/end，外部 Assignment 却为超时失败。现有 managedTurnExecutor 会在 prompt 正常返回时直接提取 snapshot 中最后一个 complete assistant，未找到有效最终回答时可得到空文本；需要进一步以受控取消测试核实中止终态传播。不能只把所有空结果判失败，因为当前契约允许合法空字符串原文结果。
3. Console 的 Conversation.status=active 表示上下文未归档，不代表 Run 仍运行；应与 queued/running/completed/failed 的任务状态区分。

本次没有恢复、重试或修改该 Run，没有提高时限，没有改 Dispatcher/Runtime。配置域解耦也未部署到该运行实例；诊断不能归因于未上线的新解析器。

代码定位：`runtimes/pi/packages/server/src/orchestration/dispatcher.ts`（固定计时与 timedOut）、`runtime/turn-executor.ts`（prompt 返回及 snapshot 提取）、`embed/conversations/service.ts`（按 result.ok 写 assistant/message 和 turn/end）。
