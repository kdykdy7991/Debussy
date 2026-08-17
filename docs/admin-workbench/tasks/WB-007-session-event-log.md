# WB-007：Session Event Log 补强

状态：Blocked by WB-000

## 目标

把现有 PostgreSQL Conversation Event 完善为可恢复、可排查、可导出的追加式权威日志。

## 修改范围

- protocol Session Event 类型
- `server/src/embed/conversations/`
- `server/src/runtime/context-restore.ts`
- PostgreSQL migration/repository
- Event Log 专项测试

## 交付

1. 统一 Event Envelope 和 schemaVersion。
2. Turn、Context、Assistant、Tool、Attachment、中断事件。
3. `event_count`、`event_bytes`、`turn_count` 事务计数。
4. payload 字节上限和超大 Artifact 引用。
5. standard/diagnostic/full 日志等级。
6. 崩溃恢复通过追加事件闭合中断 Turn。

## 禁止

- 不创建每会话 JSONL 文件。
- 不增加 Segment 表。
- 不改写已提交事件。
- 不记录 Token、PEM、原始用户标识或 Provider secret。

## 验收

- 并发 append 后 sequence 连续无空洞。
- 失败事务不增加 sequence 或计数。
- payload 大小按 UTF-8 字节计算。
- standard 等级可恢复最终 Transcript。
- 中断 Tool 明确区分未开始和结果未知。
- migration/repository/runtime 专项测试及 `npm run check` 通过。

## 交接

记录事件目录、版本兼容策略、计数事务、日志等级和恢复规则。

