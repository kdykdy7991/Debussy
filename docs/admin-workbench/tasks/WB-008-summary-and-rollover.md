# WB-008：Summary 与自动续接

状态：Blocked by WB-007

## 目标

限制模型恢复成本和单 Conversation 增长，同时保留完整旧历史。

## 修改范围

- `conversation_summaries` migration/repository
- Runtime context restore
- Conversation create/turn service
- protocol rollover 响应
- Embed/Admin rollover UI

## 交付

1. Summary 数据模型和生成服务。
2. `throughSequence` 必须位于完整 Turn 边界。
3. Runtime 使用最新 Summary + 后续事件。
4. 事件数、字节数和 Turn 数可配置上限。
5. 完成当前 Turn 后 rollover 到新 Conversation。
6. previous/next Conversation 安全关联。

## 禁止

- 不静默删除旧事件。
- 不重新编号 sequence。
- 不在半个 Turn 中间 Summary 或 rollover。
- Summary 失败不得改变旧 Conversation 可恢复性。

## 验收

- Summary 单调前进且不能越过日志尾部。
- 恢复结果包含 Summary 关键事实和最近事件。
- 三种上限任一达到都触发续接。
- 前后 Conversation tenant/app/principal/version 关系合法。
- 原 Conversation 只读，新 Conversation 可继续。
- 专项边界和并发测试、`npm run check` 通过。

## 交接

记录摘要 Prompt/算法、触发阈值、失败策略和 rollover 协议。

