# 管理员工作台开发任务索引

状态：执行中（WB-000~WB-008 已完成，当前从 WB-006 继续）

总规格：[管理员工作台整合与会话日志实施规格](../../ADMIN-WORKBENCH-INTEGRATION-IMPLEMENTATION.md)

本目录是单开发工程师的唯一执行入口。工程师收到一次启动指令后，必须按本文顺序连续完成全部 Task；每项完成后自行验证、写 handoff、更新状态并进入下一项，不需要产品负责人逐项派发或确认。

## 任务矩阵

| ID | 任务 | 主要范围 | 前置 | 可并行 |
|---|---|---|---|---|
| [WB-000](./WB-000-contracts-and-routing.md) | 冻结契约、术语和路由 | protocol/docs | 无 | 否，必须最先 |
| [WB-001](./WB-001-admin-embed-build-split.md) | Admin/Embed 构建拆分 | web/build | WB-000 | 可与 WB-007 并行 |
| [WB-002](./WB-002-admin-shell.md) | 管理员 App Shell | web/admin | WB-000、WB-001 | 可与 WB-007 并行 |
| [WB-003](./WB-003-agent-workspace.md) | Agent 工作区 | web/server/protocol | WB-000、WB-002 | 可与 WB-007 并行 |
| [WB-004](./WB-004-app-publishing-workspace.md) | 应用与发布工作区 | web/control | WB-002、WB-003 | 否 |
| [WB-005](./WB-005-preview-and-activation.md) | 预览与上线闭环 | web/embed/server | WB-001、WB-004 | 否 |
| [WB-006](./WB-006-user-conversation-console.md) | 用户会话控制台 | web/control | WB-002、WB-007、WB-008 | 可与 WB-009 后半并行 |
| [WB-007](./WB-007-session-event-log.md) | Session Event Log 补强 | server/protocol/db | WB-000 | 可与 WB-001～003 并行 |
| [WB-008](./WB-008-summary-and-rollover.md) | Summary 与自动续接 | server/protocol/db/web | WB-007 | 否 |
| [WB-009](./WB-009-session-export.md) | 会话日志导出 | server/control/web | WB-007；完整 UI 依赖 WB-006 | 后端可提前 |
| [WB-010](./WB-010-enterprise-embed-sdk.md) | 企业 Embed SDK | embed/protocol/docs | WB-001、WB-005 | 可与 WB-006/009 并行 |

## 一次性执行规则

只有一名开发，严格按以下顺序串行执行，不同时开发多个 Task：

| 顺序 | Task | 开始条件 | 完成后开放 |
|---:|---|---|---|
| 1 | WB-000 | 已完成；读取现有 handoff | WB-001 |
| 2 | WB-001 | WB-000 handoff 存在 | WB-002 |
| 3 | WB-002 | WB-001 自检通过并写完 handoff | WB-003 |
| 4 | WB-003 | WB-002 自检通过并写完 handoff | WB-004 |
| 5 | WB-004 | WB-003 自检通过并写完 handoff | WB-005 |
| 6 | WB-005 | WB-004 自检通过并写完 handoff | WB-007 |
| 7 | WB-007 | WB-005 自检通过并写完 handoff | WB-008 |
| 8 | WB-008 | WB-007 自检通过并写完 handoff | WB-006 |
| 9 | WB-006 | WB-008 自检通过并写完 handoff | WB-009 |
| 10 | WB-009 | WB-006 自检通过并写完 handoff | WB-010 |
| 11 | WB-010 | WB-009 自检通过并写完 handoff | 整体浏览器与宿主验收 |

当前状态：WB-000 已完成并有 handoff；下一项是 WB-001。

采用这个顺序的原因：

- 先拆构建和建立 Shell，再建设 Agent、应用、预览闭环。
- 用户会话控制台必须等待 Event Log 和 Summary/Rollover 契约稳定。
- 日志导出必须等待用户会话的权限、脱敏和审计入口稳定。
- 企业 SDK 最后接入已经稳定的 Embed、Preview 和身份链路。

每个 Task 的自动状态流转：

```text
Blocked/Ready
  ↓ 前置 handoff 存在且无阻断项
In Progress
  ↓ 代码、专项测试和 handoff 完成
Complete
  ↓
自动开始下一 Task
```

进入下一项前必须同时满足：任务单验收项已逐条核对、专项测试已运行、`npm run check` 已运行、handoff 已创建、任务状态已改为 `Complete`。非本任务引入的既有失败可以记录后继续；本任务引入的失败必须修复。只有遇到无法在现有规格内解决的产品决策、破坏性操作或外部权限阻塞时，才暂停并联系负责人。

## 每项读取内容与 handoff 位置

每个 Task 开始前，按顺序阅读：

1. `/Users/dykong/Documents/Debussy/runtimes/pi/AGENTS.md`；
2. [总设计规格](../../ADMIN-WORKBENCH-INTEGRATION-IMPLEMENTATION.md)；
3. 本 README；
4. 当前 Task 文件；
5. 上一顺序 Task 的 handoff；如当前任务单声明了其他前置，也一并读取对应 handoff；
6. 当前 Task 涉及目录中的其他 `AGENTS.md`（如果存在）。

所有 handoff 固定写入 `/Users/dykong/Documents/Debussy/docs/admin-workbench/handoffs/`：

| Task | 当前任务单 | 完成后 handoff |
|---|---|---|
| WB-000 | `tasks/WB-000-contracts-and-routing.md` | `handoffs/WB-000-contracts-and-routing.md` |
| WB-001 | `tasks/WB-001-admin-embed-build-split.md` | `handoffs/WB-001-admin-embed-build-split.md` |
| WB-002 | `tasks/WB-002-admin-shell.md` | `handoffs/WB-002-admin-shell.md` |
| WB-003 | `tasks/WB-003-agent-workspace.md` | `handoffs/WB-003-agent-workspace.md` |
| WB-004 | `tasks/WB-004-app-publishing-workspace.md` | `handoffs/WB-004-app-publishing-workspace.md` |
| WB-005 | `tasks/WB-005-preview-and-activation.md` | `handoffs/WB-005-preview-and-activation.md` |
| WB-007 | `tasks/WB-007-session-event-log.md` | `handoffs/WB-007-session-event-log.md` |
| WB-008 | `tasks/WB-008-summary-and-rollover.md` | `handoffs/WB-008-summary-and-rollover.md` |
| WB-006 | `tasks/WB-006-user-conversation-console.md` | `handoffs/WB-006-user-conversation-console.md` |
| WB-009 | `tasks/WB-009-session-export.md` | `handoffs/WB-009-session-export.md` |
| WB-010 | `tasks/WB-010-enterprise-embed-sdk.md` | `handoffs/WB-010-enterprise-embed-sdk.md` |

每份 handoff 至少记录：完成范围、实际修改文件、关键接口/数据结构、迁移或兼容策略、执行过的命令及结果、未关闭项、对下一 Task 的约束。handoff 是下一项的输入，不是可选的工作总结。

## 如何一次性交给开发

负责人只需要发送下面这一段一次，之后无需逐项派发：

```text
请连续完成管理员工作台剩余开发任务。

唯一执行入口：
/Users/dykong/Documents/Debussy/docs/admin-workbench/tasks/README.md

WB-000 已完成，请从 WB-001 开始。严格按 README 的“一次性执行规则”和表格顺序串行推进至 WB-010。每项开始前读取规定文档；完成后执行验收、更新任务状态，并在规定路径写 handoff，然后自行进入下一项，不需要等待我逐项确认。

遇到普通实现问题请依据总规格、任务单和上游 handoff自行解决并记录。只有需要新增产品决策、执行破坏性操作、缺少外部权限，或本任务引入的失败无法解决时才暂停联系我。保留工作区已有修改，不提交代码，除非我另行明确要求。
```

## 通用完成要求

- 只修改任务单列出的允许范围；需要跨范围时先更新任务单并评审。
- 不覆盖工作区中其他工程师的未提交修改。
- 新协议先写 protocol 类型和 codec/schema 测试，再接 Server/Web。
- 新数据库行为必须有 migration、repository 测试和跨 scope 测试。
- 新 UI 必须覆盖 loading、empty、error、retry、401 锁定和未知状态。
- 修改代码后运行 `runtimes/pi/npm run check`；测试只运行任务单列出的专项文件，不直接运行完整 Vitest suite。
- 每个任务完成后在 `docs/admin-workbench/handoffs/` 创建同 ID 交接文档，记录实际文件、接口偏差、测试结果和未关闭项。
- 未完成真实 Chromium 或真实宿主验证时，只能标记自动化通过，不能宣称端到端完成。
