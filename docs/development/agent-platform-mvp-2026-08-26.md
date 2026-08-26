# Agent 平台 MVP 实施规格

状态：实施中  
创建日期：2026-08-26  
目标用户：约 10～20 名内部团队成员  
正式容量目标：20 个同时进行的文本对话

## 1. 目标

MVP 必须闭合以下真实链路：

```text
导入 Skill
→ 配置 MCP Server 并同步 Tools
→ 创建 Agent
→ 绑定 Skill 与允许的 MCP Tools
→ 管理员 Chat 调试
→ 创建并激活 Published App Version
→ 发布 Chat / Embed 使用
→ Runtime 注入 Skill、调用 MCP Tool
→ Usage / Session 日志排障
→ 暂停或回滚应用版本
```

页面存在、协议类型存在或单元测试通过都不能单独代表 MVP 完成。只有上述链路使用真实存储、真实 Runtime 和真实浏览器完成验收，才可进入内部日常使用。

## 2. 当前代码基线

以下结论以 `origin/main` 的实际生产入口为准，不以历史计划或未挂载组件为准。

| 能力 | 当前状态 | MVP 处理 |
| --- | --- | --- |
| Agent 列表、详情、编辑、软删除 | 已有真实 Control API 和生产页面；创建入口、分页与部分交互仍需收口 | 保留并补齐 |
| Agent Revision | 保存生成不可变 Revision；发布版本可冻结配置 | 保留底层机制，不建设 Revision 管理 UI |
| 模型与 reasoning | 已有模型目录、服务端白名单、Revision 默认和会话覆盖 | 保留并回归 |
| 管理员 Chat | 已有真实 Runtime、流式正文/思考和停止能力 | 保留并接入 Skill/MCP |
| Published App / Embed | 已有版本、激活、暂停、回滚、Launch Token、Realtime 和共享消息视图 | 保留并接入 Skill/MCP |
| Usage / Session 日志 | 已有指标、上下文、会话查询和管理界面基础 | 保留为排障能力，不扩展 BI |
| Skill | 仓库已有 `SKILL.md` 发现、解析、诊断和 prompt 注入基础；协议 DTO 仍是历史候选，缺少租户级持久化、管理 API/UI、发布绑定和发布 Runtime 接线 | MVP 核心待实现 |
| MCP | 只有管理 DTO 草案；缺少批准的 Transport、Secret 存储、管理 API/UI、Tool discovery、allowlist 和 Runtime 客户端 | MVP 核心待实现 |
| 发布 Runtime 的 Tools/Knowledge Bases | `pi-runtime-adapter.ts` 当前明确拒绝非空 tools/knowledgeBases | 必须改为受控执行 |
| Avatar、实时语音 | 已有部分代码与控件，但不属于文本 Agent MVP 门禁 | 不阻断 MVP |

## 3. MVP 产品范围

### 3.1 Agent 管理

- 从真实 API 加载、搜索、创建、编辑和软删除 Agent。
- 编辑名称、描述、System Prompt、模型和模型支持的 reasoning 设置。
- 保存时生成不可变的内部 Revision。
- 展示 saved、dirty、saving、error；保存失败保留草稿，离开未保存页面前提示。
- 从 Agent 进入管理员 Chat，并明确当前测试的 Agent。
- Agent 列表不得出现无行为的分页、创建、发布或成功控件。
- 删除 Agent 前检查有效应用引用；有关联应用时返回明确冲突，不级联删除。

### 3.2 极简 Revision 与发布冻结

Revision 是内部一致性机制，不是 MVP 的独立产品模块：

- 每次保存生成不可变配置快照。
- 用户界面使用“保存”，可辅助说明保存会生成新版本。
- 不建设 Revision 列表、Diff、详情缓存、恢复或比较 UI。
- 发布时将 Agent、Skill Revision、MCP Revision、Tool allowlist 和必要策略编译为不可变 RuntimeSpec。
- Conversation 固定 Published App Version；Agent、Skill 或 MCP 后续变化不得改变旧会话。
- 长期只需保留最新 Agent 配置、被发布版本引用的快照和满足审计/误删恢复期限的少量历史记录。

### 3.3 Skill

- 提供租户级 Skill 列表、导入、详情、更新、启停和软删除。
- MVP 导入格式只允许单个 `SKILL.md` 文件或 ZIP；不接受任意服务端路径。
- 复用 `packages/coding-agent/src/core/skills.ts` 的解析和诊断语义，不重复实现第二套 frontmatter 规则。
- 原始文件、解析结果、诊断、内容 hash 和不可变 Skill Revision 可追溯。
- 导入必须限制文件数量、单文件大小、总大小和允许的文件类型，并拒绝路径穿越、绝对路径、符号链接逃逸及不允许的可执行内容。
- Agent 编辑页通过服务端目录选择 Skill Revision，不允许手填任意 ID。
- 发布时固定具体 Skill Revision；Skill 后续更新、停用或删除不改变旧发布版本。
- Runtime 只加载发布版本固定且允许的 Skill，并将实际 Skill 指令计入上下文快照。
- MVP 不做 Skill Diff、历史版本管理 UI、在线文件编辑器和第三方 Skill 市场。

### 3.4 MCP

- 提供租户级 MCP Server 列表、创建、编辑、连接测试、Tool 同步、启停和软删除。
- MVP 只支持一个经安全评审的远程 Transport；首选候选为 Streamable HTTP，stdio 不进入 MVP。
- 正式编码前必须用真实 MCP Server 完成 SDK/客户端方案最小原型，记录依赖版本、许可证、超时/取消、重连和退出成本。
- 普通配置与 Secret 分开；浏览器只提交 Secret 的新值或替换动作，读取永不回显。
- 服务端只在执行边界解析 Secret；Secret 不进入 RuntimeSpec、事件、导出、日志和错误响应。
- 连接测试和 Tool discovery 必须返回真实状态，不以静态成功代替。
- 同步保存 Tool 名称、描述和输入 schema 快照。
- Agent 编辑页选择 MCP Revision 和 Tool allowlist；新发现 Tool 默认不选。
- 发布时固定 MCP Revision 与 Tool allowlist；Runtime 拒绝任何未发布 Tool。
- Runtime 覆盖超时、取消、断连、响应大小、并发限制和错误映射；MCP 失败不能破坏文本消息事件顺序。
- 服务端必须防护 DNS/重定向/私网绕过等 SSRF，执行租户隔离并留下不含敏感参数的审计记录。
- MVP 不做 stdio、MCP OAuth、多 Transport、自动定时同步和复杂工作流编排。

### 3.5 Chat、发布与 Embed

- 管理员 Chat 与发布 Chat/Embed 继续复用同一结构化消息视图。
- 正文、思考和 Tool 调用事件必须来自真实 Runtime 增量。
- 用户停止生成时同时取消模型与正在执行的 MCP 调用。
- 发布前校验所有 Skill/MCP 引用存在、启用、同租户且可发布；失败时阻止创建版本并返回具体诊断。
- 创建 Published App Version 与激活上线保持两个动作。
- 支持暂停和回滚；回滚后新会话使用目标版本，既有 Conversation 继续遵守固定版本语义。
- Launch Token、Embed Access Token、MCP Secret 和 Provider Secret 均不得进入 URL、浏览器持久化存储或日志。

### 3.6 排障和运行保障

- 管理员可从 Session 日志定位应用、版本、Agent、会话状态、失败原因和 request ID。
- Usage 至少保留 input/output Token、来源和基础耗时；旧数据不可用时不伪造为 0。
- Tool 调用审计记录 MCP Server、Tool、会话、结果状态、耗时和截断标记，不记录 Secret 或默认记录完整参数/结果。
- Skill/MCP 功能可独立关闭；关闭后不允许新发布含对应能力的版本，纯文本 Agent 仍可工作。
- 当前机器仍可用时，数据库和必要 Secret 引用可从本地备份恢复。

## 4. 明确不做

- Revision 列表、Diff、比较、恢复、详情缓存和 Revision 管理 Tab。
- Agent 页面中的发布应用 Tab、最近调试 Tab和重复发布工作流。
- Skill Diff、在线编辑、市场、评分和自动更新。
- MCP stdio、OAuth、多 Transport、定时健康巡检和自动 Tool 授权。
- Web Search、通用知识库产品、RAG 编排器和工作流编排。
- Avatar、实时语音、数字人和公网 SLA。
- 复杂组织权限、审批流、计费、BI 和模型训练。
- 管理员工作台移动端专项适配；发布 Chat/Embed 仍按产品兼容范围验收。

## 5. 删除与引用语义

- Agent、Skill、MCP Server 和 Published App 默认软删除。
- Agent 被有效应用引用时禁止删除；先解绑或归档应用。
- Skill/MCP 被未发布 Agent 草稿引用时允许先解除绑定再删除。
- 被 Published App Version 引用的 Skill Revision、MCP Revision、Tool schema 和 RuntimeSpec 不得物理删除。
- 停用 Skill/MCP 阻止新的绑定和发布，但不能静默修改历史发布版本。
- Secret 被删除或失效后，相关 Tool 调用明确失败；正文对话是否继续由已冻结的降级策略决定，不能伪造 Tool 成功。

## 6. 实施顺序

### 阶段 A：现有主链路收口

1. 修正当前生产 Agent 页面与真实 RuntimeSpec 的字段上限和保存语义。
2. 接通创建 Agent，删除静态分页和未挂载的旧工作台代码。
3. 为当前生产入口补真实 API、模型目录、保存失败和未保存离开测试。
4. 保持发布、Chat、Embed、reasoning 和回滚回归通过。

### 阶段 B：Skill 产品化

1. 冻结 Skill 导入格式、数据模型、API、错误码和删除语义。
2. 实现安全导入、Revision、持久化和管理 API。
3. 实现 Skill 管理 UI 和 Agent 绑定。
4. 扩展 RuntimeSpec 与发布 Runtime，完成上下文计量。
5. 完成安全、跨租户、版本冻结和关闭开关验证。

### 阶段 C：MCP 产品化

1. 完成 Transport/SDK/Secret/SSRF 方案原型和安全评审。
2. 冻结 MCP 数据模型、API、错误码和审计字段。
3. 实现管理 API、Secret 引用、连接测试和 Tool discovery。
4. 实现管理 UI、Agent 绑定和 Tool allowlist。
5. 扩展 RuntimeSpec 与 Runtime Tool 执行，完成取消和故障隔离。
6. 完成跨租户、SSRF、Secret 脱敏、版本冻结和关闭开关验证。

### 阶段 D：全链路验收

1. 在同一候选提交完成 Skill + MCP + Agent + 发布 + Embed 真实 E2E。
2. 完成真实模型和真实 MCP Server 验收。
3. 完成 20 个同时对话、30 个同时在途轮次、备份恢复和版本回滚。
4. 按验收文档关闭所有 P0 阻断项。

## 7. 相关任务文档

- [后端任务](./agent-platform-mvp-backend-2026-08-26.md)
- [前端任务](./agent-platform-mvp-frontend-2026-08-26.md)
- [验收与检查清单](./agent-platform-mvp-acceptance-2026-08-26.md)

稳定产品规则以 `docs/product/` 为准；本文件只记录当前 MVP 的实施范围和完成条件。
