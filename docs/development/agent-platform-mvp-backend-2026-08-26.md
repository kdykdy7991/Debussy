# Agent 平台 MVP 后端任务

状态：代码完成，待带 PostgreSQL 的集成环境验收  
创建日期：2026-08-26  
主规格：[Agent 平台 MVP](./agent-platform-mvp-2026-08-26.md)

## 1. 当前可复用能力

- `packages/coding-agent/src/core/skills.ts`：Skill 发现、frontmatter 解析、名称/描述诊断和 prompt 注入语义。
- `packages/protocol/src/admin-workbench-skills.ts`：Skill DTO 草案，只可作为输入材料，实施前须去除历史 V2 语义并按本规格复核。
- `packages/protocol/src/admin-workbench-mcp.ts`：MCP DTO 草案；Transport 和 Secret 写入语义尚未冻结。
- `packages/server/src/publishing/runtime-spec/`：不可变 RuntimeSpec、严格 schema、编译、白名单和 hash。
- `packages/server/src/publishing/control/`：Agent Revision、Published App Version、激活、暂停和回滚。
- `packages/server/src/runtime/`：Conversation 固定版本、流式事件和停止执行。
- `packages/server/src/runtime/pi-runtime-adapter.ts`：当前 chat-only 门禁明确拒绝 tools/knowledgeBases，是 Skill/MCP Runtime 接线的直接阻断点。

不得重新实现现有 Skill parser、发布版本状态机、Realtime 会话管理或消息事件协议；应在现有边界内扩展。

## 2. 现有主链路收口

- 提供完整的 Agent 创建接口并覆盖租户、验证、冲突和幂等测试。
- Agent 更新继续生成不可变 Revision，但不依赖 Revision 管理 UI。
- 保存请求使用 RuntimeSpec 的真实 System Prompt 上限，前后端共享常量或协议约束。
- Agent 软删除继续拒绝有效应用引用；补充并发删除与发布的事务边界测试。
- 识别并删除仅服务未挂载旧工作台的接口；发布、Chat 或兼容读取仍使用的接口不得误删。

## 3. Skill 数据与 API

### 3.1 数据模型

至少建立：

- `skills`：租户、公共 ID、名称、状态、当前 Revision、软删除时间。
- `skill_revisions`：不可变 Revision、source hash、原始 artifact 引用、解析结果、诊断、创建人和时间。
- `agent_revision_skills`：Agent Revision 到 Skill Revision 的固定绑定及顺序。

约束：

- 所有唯一键包含 Tenant 作用域。
- 发布引用的 Revision 不得物理删除。
- 更新 Skill 只创建新 Revision，不改写旧 Revision。
- 内容 hash 对相同规范化输入稳定。
- 大文件正文不直接堆入高频列表表；原始 artifact 与结构化元数据分离。

### 3.2 导入边界

- MVP 接受单个 `SKILL.md` 或 ZIP artifact，不接受服务端本地路径。
- ZIP 解包到隔离临时目录；拒绝绝对路径、`..`、设备文件、符号链接和硬链接。
- 配置文件数、单文件大小、总解包大小和压缩比上限。
- 只读取明确允许的文本/资源类型；不执行导入内容。
- 复用 coding-agent Skill parser，将诊断转换为稳定 API 错误。
- 导入失败不留下半成品数据库记录或孤立 artifact。

### 3.3 Control API

至少提供：

```text
GET    /api/control/v1/skills
POST   /api/control/v1/skills/import
GET    /api/control/v1/skills/:skillId
POST   /api/control/v1/skills/:skillId/revisions
POST   /api/control/v1/skills/:skillId/validate
PATCH  /api/control/v1/skills/:skillId/status
DELETE /api/control/v1/skills/:skillId
```

Agent 保存请求直接提交经服务端验证的 Skill Revision 引用；无需另建面向用户的 Agent Revision 绑定页面 API。服务端必须拒绝不存在、停用、跨租户或有阻断诊断的绑定。

## 4. MCP 方案门禁

实施结论（2026-08-26）：门禁通过，采用官方 `@modelcontextprotocol/client@2.0.0` 的
`Client` + `StreamableHTTPClientTransport`，不自研 JSON-RPC/MCP 协议栈。HTTP 与连接限制
使用 `undici@8.5.0`，IP 分类使用 `ipaddr.js@2.5.0`；均精确锁定版本。原型测试使用官方
`@modelcontextprotocol/server@2.0.0` 建立真实 Streamable HTTP Server，已覆盖 initialize、
Tool discovery、Tool call、AbortSignal 和关闭。运行时禁用 SDK 列表缓存、协议重连和 HTTP
重定向；每次 Tool 调用创建有界会话并在 `finally` 关闭，避免跨租户/凭据上下文复用。

依赖审查：上述包为 MIT；Node 要求与项目的 `>=22.19.0` 一致；安装使用
`npm install --ignore-scripts`。业务代码仅实现租户/Revision/Secret/审计边界。

正式实现前必须先完成最小原型并记录选择：

1. 比较仓库现有能力、维护中的 MCP 客户端/SDK 和自研客户端。
2. 用真实 Streamable HTTP Server 验证 initialize、Tool discovery、Tool call、超时、AbortSignal、断连和 schema 错误。
3. 审查精确依赖版本、许可证、安装脚本、传递依赖、Node 兼容性和替换边界。
4. 明确连接池/会话生命周期、重试边界和关闭行为。
5. 完成出站网络和 Secret 威胁模型；门禁通过前不得开放任意 URL Runtime 调用。

MVP 不实现 stdio。

## 5. MCP 数据、Secret 与 API

### 5.1 数据模型

至少建立：

- `mcp_servers`：租户、公共 ID、名称、状态、当前 Revision 和软删除时间。
- `mcp_server_revisions`：不可变 Transport 配置、端点、Secret 引用和创建信息。
- `mcp_tools`：所属 MCP Revision、Tool ID/名称/描述、input schema hash 和完整 schema 快照。
- `agent_revision_mcp_bindings`：Agent Revision、MCP Revision 和 Tool allowlist。
- `mcp_call_audits`：租户、会话、发布版本、Server、Tool、结果、耗时、截断和 request ID。

Secret 值必须存入独立 Secret store 或受保护的凭据表；普通仓储层和详情 DTO 只接触 opaque ref 与 `secretConfigured`。

### 5.2 Control API

至少提供：

```text
GET    /api/control/v1/mcp-servers
POST   /api/control/v1/mcp-servers
GET    /api/control/v1/mcp-servers/:mcpServerId
POST   /api/control/v1/mcp-servers/:mcpServerId/revisions
POST   /api/control/v1/mcp-servers/:mcpServerId/secret
POST   /api/control/v1/mcp-servers/:mcpServerId/test
POST   /api/control/v1/mcp-servers/:mcpServerId/sync-tools
PATCH  /api/control/v1/mcp-servers/:mcpServerId/status
DELETE /api/control/v1/mcp-servers/:mcpServerId
```

读取 API 永不返回 Secret。创建或替换 Secret 的响应也只返回配置状态。

## 6. MCP 网络安全

- 端点只允许 `https`；开发环境例外必须通过显式配置启用并留下启动警告。
- URL 解析、DNS 解析和实际连接目标都执行策略检查。
- 默认拒绝 loopback、link-local、私网、metadata 地址、非 IP 标准表示和未批准端口。
- 每次重定向重新校验目标；限制重定向次数。
- 防 DNS rebinding：解析结果与实际连接目标策略一致，连接生命周期内不静默切换到被拒绝地址。
- 限制请求/响应 header、body、Tool schema 和 Tool result 大小。
- Tool 调用使用硬超时和 AbortSignal；会话取消、连接关闭和服务停机均释放资源。
- 日志、错误和审计对 URL 凭据、headers、Tool 参数和结果执行脱敏/截断。

## 7. 发布与 Runtime

- RuntimeSpec 必须固定 Skill Revision、MCP Revision、Tool schema hash 和 allowlist；是否升级 schemaVersion 由兼容性评审决定，不能只塞入无语义的任意对象。
- Compiler 验证所有引用同租户、存在、启用且可发布。
- RuntimeSpec 不含 Secret 值，只含执行所需公共元数据和服务端可解析的受限引用。
- 发布 Runtime 从固定 Skill Revision 构造 Skill prompt/context，不读取“当前最新 Skill”。
- Runtime MCP 客户端只能暴露 allowlist 内 Tool；discovery 的新增 Tool 不自动生效。
- Tool 定义、Skill 指令和 Tool 结果分别进入上下文快照计量。
- Tool 调用产生结构化开始、完成、失败和取消事件，保持管理员 Chat 与 Embed 消息语义一致。
- Tool 失败遵守冻结降级策略；不得伪造成功、吞掉错误或破坏后续文本事件。
- 功能开关关闭时，拒绝新发布含对应能力的版本；纯文本发布版本继续运行。

## 8. 删除与恢复

- Agent 有有效应用引用时拒绝删除。
- Skill/MCP 的逻辑主体可软删除，但发布版本引用的 Revision 和 schema 快照保留。
- Secret 删除立即使后续 Tool 调用失败，但不得删除历史审计或改写 RuntimeSpec。
- 备份包含 Skill/MCP 元数据、Revision、绑定、schema、审计和 Secret 引用；Secret 值按 Secret store 的独立恢复流程处理。
- 恢复后执行一次发布版本编译校验和真实 MCP 连接测试。

## 9. 后端完成标准

- Skill/MCP 所有接口覆盖成功、验证失败、无权限、跨租户、冲突和不存在。
- 非法 ZIP、路径穿越、符号链接、超限和不允许文件全部被拒绝。
- SSRF、重定向绕过、DNS rebinding 候选、超时、断连、超大结果和取消全部有自动化测试。
- 未发布 Tool 调用失败；MCP 新增 Tool 不影响旧发布版本。
- Skill/MCP 更新后旧 Published App Version 和旧 Conversation 不漂移。
- Secret 不出现在 RuntimeSpec、API 响应、事件、日志、导出和测试快照。
- MCP 故障不导致进程、socket、promise、并发槽或会话状态泄漏。
- 关闭 Skill/MCP 后纯文本对话仍通过回归。

## 10. 2026-08-26 实施结果

已完成：

- Agent 创建、不可变 Revision 保存、删除引用检查与创建/删除并发边界。
- Skill artifact/Revision/绑定数据模型，安全 ZIP 与 `SKILL.md` 导入，Control API，发布冻结和运行时 prompt 注入。
- MCP Server/Revision/Tool/Secret/Agent 绑定/调用审计数据模型及全部 Control API。
- 官方 MCP SDK 的 Streamable HTTP discovery/call/abort/close；不实现 stdio、不自研 JSON-RPC、不启用列表缓存或协议重试。
- HTTPS/端口/DNS/IP/重定向/响应大小/超时门禁，DNS 结果连接期固定；开发 HTTP/私网仅通过显式策略开放。
- AES-256-GCM Secret 密文存储，Tenant + Server AAD 绑定；API、RuntimeSpec、审计和 Tool 结果不包含 Secret。
- RuntimeSpec 固定 Skill Revision、MCP Revision、完整 Tool schema/hash 与 allowlist；Runtime 只暴露固定 Tool，并在调用时检查 Server kill switch。
- MCP HTTP 请求断开传播 `AbortSignal`；Tool 结果有界截断；成功、失败、取消均写结构化审计且不记录参数和结果正文。

复用的成熟实现均为精确版本：`@modelcontextprotocol/client@2.0.0`、
`@modelcontextprotocol/server@2.0.0`（测试原型）、`undici@8.5.0`、
`ipaddr.js@2.5.0`、`fflate@0.8.2`。业务代码只负责产品数据、权限、安全策略和组合层。

本机验证：MCP/Skill/发布聚焦测试 69 个通过、38 个因测试数据库未启动而跳过；server 全套最近一次为
564 个通过、272 个跳过（补充 HTTP 数据库用例前）。
数据库集成用例已经覆盖 MCP Revision、Secret 密文、跨租户隔离、Agent 绑定、发布快照和 HTTP 生命周期，需在
`PI_TEST_DATABASE_URL` 可用的环境执行。全仓 `npm run check` 当前被既有 Web 预览 SVG 可访问性及测试 lint
问题阻断；server 全套另有既有 AI `dist/providers/data/amazon-bedrock.json` 缺失和 principal 类型断言漂移。
