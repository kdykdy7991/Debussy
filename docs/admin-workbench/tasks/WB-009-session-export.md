# WB-009：会话日志流式导出

状态：Complete（handoff 见 `handoffs/WB-009-session-export.md`）

## 目标

从 PostgreSQL 权威事件日志生成一致、可验证、内存有界的 JSONL ZIP。

## 修改范围

- Admin export protocol/HTTP
- Server ZIP 流和 Transcript 投影
- Admin 用户会话导出 UI
- 导出专项测试

## 交付

1. 脱敏诊断包、完整包和 Transcript 三种模式。
2. 导出开始时冻结 `throughSequence`。
3. `manifest.json`、`session.jsonl`、`transcript.md`、`diagnostics.json` 和可选附件。
4. 数据库分页读取、流式压缩、取消传播和背压。
5. 完整导出二次确认及审计。

## 禁止

- 不落服务器本地磁盘。
- 不在内存中组装完整 ZIP 或完整事件数组。
- 不从 UI 投影反向拼权威日志。
- 不静默跳过 sequence 缺口或缺失附件。

## 验收

- JSONL 从首事件到 throughSequence 连续。
- 导出期间新增事件不进入当前 ZIP。
- 大会话内存保持有界。
- 客户端取消后数据库和压缩工作停止。
- 脱敏包不含敏感字段。
- 导出审计可查询。

## 交接

记录 ZIP 格式版本、分页大小、背压上限、脱敏规则和失败语义。

