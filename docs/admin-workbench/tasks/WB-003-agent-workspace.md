# WB-003：Agent 工作区

状态：Complete（handoff 见 `handoffs/WB-003-agent-workspace.md`）

## 目标

实现 Agent 选择、配置表单、dirty draft、保存 revision、revision 历史、关联应用和按 Agent 恢复 DebugSession。

## 修改范围

- `runtimes/pi/packages/web/src/admin/agents/`
- `runtimes/pi/packages/web/src/admin/conversation/`
- Agent Control API 对应 protocol/server 文件
- Agent/DebugSession 专项测试

## 交付

1. 顶部 Agent 选择器。
2. 每个 Agent 独立恢复最近 DebugSession。
3. Agent 配置表单：Prompt、模型、工具、知识库和能力。
4. dirty/saving/saved/error 状态机。
5. 保存生成不可变 revision。
6. Revision Diff、关联应用和调试记录页签。

## 禁止

- 历史 revision 不可原地修改。
- 未保存草稿不可发布。
- 切换 Agent 不得复用原 Agent 上下文。
- 不把应用主题、Origin、accessMode 混入 Agent 配置。

## 验收

- Agent A/B 切换后恢复各自会话和配置。
- 保存失败保留草稿并可重试。
- 刷新时对未保存修改给出明确提示。
- API 跨 tenant 返回统一 404。
- 专项测试、Web/Server typecheck、`npm run check` 通过。

## 交接

记录 Agent 草稿所有权、revision 创建契约、DebugSession 映射和未实现字段。

