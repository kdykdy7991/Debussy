# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- 企业内的管理员：配置 Agent、创建可嵌入企业网站的应用、验证并发布版本、排查线上问题。
- 企业网站接入开发者：取得接入方式、受允许的 Origin、当前生产版本等必要信息。
- 运营与支持人员：在权限和脱敏边界内定位企业终端用户的异常会话。

## Product Purpose

Debussy 把 Agent 的配置、应用发布和企业网站中的对话运行统一为一个管理员工作台，同时保留独立发布的 Embed 对话 Web。成功意味着管理员不需要在独立发布后台、调试页面和日志工具之间切换，就能安全地完成从配置到线上排障的闭环。

## Positioning

这是面向“企业网站接入 AI Agent”的运维工作台，而不是泛用聊天后台：一个 Agent 可被多个应用引用；每次发布显式选择目标应用；线上会话绑定应用、发布版本和主体，并与管理员调试会话严格区分。

## Operating Context

- 管理员访问工作台后默认进入 Chat，以指定 Agent 与 Revision 完成管理员调试；需要时进入 Agent 设计、发布、Usage 或 Session 日志。
- 发布流程为草稿、预览验证、创建版本、上线与回滚；发布对话框独立呈现，但从发布应用工作区发起。
- 企业网站终端用户的会话通过 Principal 隔离；初期控制台只允许管理员访问。

## Capabilities and Constraints

- 一级模块：Chat、Agent 设计、发布、Usage、Session 日志、设置。
- Chat 只指管理员调试；Session 日志只指发布后的企业用户 Conversation。
- 发布应用持有 Public App ID、访问模式和允许 Origin；应用配置不能绕过版本直接生效。
- Usage 展示总 Token、输入/输出 Token，以及按 Agent 和来源归因的用量。
- 会话日志存储在数据库；采用有界上下文策略，并支持受控导出。
- 管理员控制台使用 React + Vite；嵌入式对话是独立构建与发布入口。

## Evidence on Hand

- 管理员工作台规格：`../../../../docs/ADMIN-WORKBENCH-INTEGRATION-IMPLEMENTATION.md`。
- UI 重构规格：`../../../../docs/ADMIN-CONSOLE-UI-REDESIGN-SPEC.md`。
- 已有 Agent、发布应用、用户会话、管理员调试对话及发布/预览实现位于 `src/admin/`。
- 不应捏造客户、线上指标、接入站点或运行数据；缺少真实连接时必须明确标示示例数据或连接错误。

## Product Principles

1. 让管理员先完成当前任务，再按对象关系进入下一步。
2. 用发布应用串起 Agent、版本、接入站点和用户会话。
3. 发布必须可理解、可验证、可回滚，且不会隐式影响其他应用。
4. 管理员调试与企业终端用户会话始终语义和权限隔离。
5. 真实状态优先；演示与降级状态不得伪装成生产数据。
