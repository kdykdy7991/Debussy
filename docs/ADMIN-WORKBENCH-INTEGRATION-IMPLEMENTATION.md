# 管理员工作台整合与会话日志实施规格

> 状态：可执行设计基线（待实施）
>
> 适用范围：`runtimes/pi/packages/web`、`runtimes/pi/packages/server`、`runtimes/pi/packages/protocol`
>
> 依赖：`MULTI-USER-PUBLISHING-MVP-SPEC.md`、`MULTI-USER-PUBLISHING-HOST-INTEGRATION.md`；旧管理台实现证据已归档到 `archive/publishing-mvp/PUBLISHING-ADMIN-CONSOLE-HANDOFF.md`。
>
> 优先级：本文覆盖旧规格中“`/publishing` 是独立管理页面”和“同一 Vite 入口仅做路径分流”的决策。既有 Control API、租户隔离、公开 ID、幂等和密钥安全约束继续有效。

## 1. 目标

把现有内部 Web 对话页升级为“对话优先的管理员工作台”，将 Agent 编辑、发布管理、应用运维和企业用户会话排查整合为一个管理员产品，同时保持面向企业网站的 Embed 对话 Web 独立构建、部署和发布。

交付后必须满足：

1. 管理员访问 `/` 后默认进入当前 Agent 的调试对话，而不是独立发布控制台。
2. 管理员可在同一工作台切换 Agent、编辑配置、保存 revision、选择 PublishedApp、创建版本、预览并上线。
3. 一个 Agent 可关联多个 PublishedApp；每次发布必须显式选择目标应用。
4. “保存 Agent”“创建发布版本”“上线版本”是三个独立动作。
5. `/embed/:publicAppId` 使用独立 Embed 构建产物，不包含管理代码。
6. 企业网站可通过 iframe 或轻量 JavaScript SDK 接入。
7. anonymous 与 signed-user 都通过 Principal 隔离会话；企业内部网站优先使用 signed-user。
8. 管理员调试 Session 与发布后的用户 Conversation 明确分离。
9. PostgreSQL 追加式事件日志是会话唯一事实来源；首版不持续生成每会话日志文件，也不引入 Segment 表。
10. 超长 Conversation 使用 Summary 检查点和自动续接，不静默删除同一 Conversation 的早期事件。
11. 管理员可将数据库事件流式导出为 JSONL ZIP，导出过程不落服务器本地磁盘。

## 2. 非目标

首期不包含：

- 企业 SSO 的最终接入；首期继续使用内存 Admin Token。
- 多角色 RBAC 管理界面；首期只有管理员身份。
- 双人发布审批。
- 测试、预发、生产多环境提升流程。
- 会话事件冷归档和 JSONL Zstd Segment。
- 跨应用共享 Principal 或 Conversation。
- 默认开启的跨会话长期用户 Memory。
- 复杂 BI、计费或成本分摊系统。
- 在一个 Conversation 内静默滚动删除旧事件。

## 3. 核心对象与关系

### 3.1 协议命名

管理员 UI 统一使用 `Agent`；持久化实体和现有 Control API 继续使用 `AgentDefinition`。两者不是两个实体：

```text
UI Agent = AgentDefinition 的管理员投影
UI AgentRevision = 一条不可变 AgentDefinition revision
```

新工作台共享 DTO 使用 `AgentSummary` / `AgentRevisionSummary`，不再新增 `AgentDefinitionSummary` 的第二套工作台模型。旧独立管理台的 `AgentDefinitionSummary` 仅作为现有 Control HTTP 兼容 DTO，迁移由 WB-003/WB-004 完成。

```text
Agent
├── AgentRevision 1
├── AgentRevision 2
└── PublishedApp[]
    ├── PublishedAppVersion[]
    ├── LaunchKey[]
    └── Principal[]
        └── Conversation[]
            ├── ConversationEvent[]
            ├── ConversationSummary[]
            └── Attachment[]
```

冻结关系：

- 一个 Agent 可以发布为多个 PublishedApp。
- PublishedAppVersion 必须引用一个已保存的 AgentRevision。
- 一个 Conversation 创建时固定 PublishedAppVersion，后续上线新版本不改变已有 Conversation。
- 同一 Principal 可以在同一 PublishedApp 下创建多个 Conversation。
- 相同企业用户在不同 PublishedApp 下得到不同 Principal，默认不共享会话。

## 4. 信息架构

### 4.1 工作台框架

```text
┌──────┬──────────────────┬─────────────────────────────┬────────────────┐
│ 图标栏 │ 当前模块侧栏       │ 主工作区                    │ 右侧功能抽屉     │
│      │                  │                             │                │
│ 对话  │ Agent/调试会话列表 │ 当前 Agent 调试对话          │ Agent 配置       │
│ Agent│ Agent 列表        │ Agent 详情                  │ 发布管理         │
│ 应用  │ 应用筛选          │ 仪表盘/应用详情              │ 快捷详情         │
│用户会话│ 会话筛选          │ 用户 Conversation 排查      │ 事件/运行信息     │
│ 设置  │ 设置分组          │ 管理认证与系统设置           │                │
└──────┴──────────────────┴─────────────────────────────┴────────────────┘
```

左侧一级标签固定为：

1. 对话
2. Agent
3. 应用
4. 用户会话
5. 设置

“对话”只表示管理员调试；“用户会话”只表示企业网站产生的真实 Conversation。界面不得把第四项简称为含义不明确的“会话”。

### 4.2 全局状态

管理员工作台需要维护：

- 当前管理员解锁状态；
- 当前 tenant；
- 当前 Agent；
- 每个 Agent 最近打开的 DebugSession；
- 当前打开的 PublishedApp；
- 右侧抽屉类型和宽度；
- 全局错误 requestId；
- 当前主题。

切换 Agent 时：

- 恢复该 Agent 最近打开的 DebugSession；
- 加载该 Agent 当前配置、草稿状态和 revision；
- 加载关联 PublishedApp 列表；
- 不清空其他 Agent 的调试会话；
- 不把原 Agent 上下文带入新 Agent。

## 5. 四个核心模块

### 5.1 对话

目标：管理员测试当前 Agent 的实际行为。

模块侧栏：

- Agent 选择器；
- 新建调试对话；
- 当前 Agent 最近调试会话；
- 已归档调试会话。

主区域：

- 消息历史；
- 工具调用；
- 引用和附件；
- 语音和 Avatar 状态；
- 输入框；
- Turn 错误和 requestId。

顶部状态：

- 当前 Agent 名称；
- 当前 AgentRevision；
- 是否存在未保存修改；
- 模型和连接状态；
- “配置”入口；
- “发布”入口。

右侧抽屉：

- Agent 配置抽屉；
- 发布抽屉；
- 工具调用详情。

约束：

- 对话模块不得展示真实企业用户会话。
- 未保存配置不能直接创建 PublishedAppVersion。
- 调试对话必须记录实际使用的 AgentRevision 或明确标记为草稿测试。

### 5.2 Agent

目标：管理 Agent 配置、revision 和关联应用。

Agent 列表字段：

- 名称和描述；
- 当前 revision；
- 模型；
- 是否存在草稿；
- 关联应用数量；
- 最近更新时间。

Agent 详情页签：

1. 配置：System Prompt、模型、参数、工具、知识库、文件、语音、Avatar、Context 策略。
2. Revision：revision 编号、创建人、创建时间、变更摘要、配置 Diff、使用它的 PublishedAppVersion。
3. 关联应用：应用状态、线上版本、待上线版本和访问模式。
4. 调试记录：该 Agent 的 DebugSession 列表。

Agent 配置状态机：

```text
saved revision
    ↓ edit
dirty draft
    ↓ save
new saved revision
```

历史 revision 不允许原地修改；“恢复”操作创建新草稿。

### 5.3 应用

目标：发布运维和企业网站接入管理。

应用首页顶部指标：

- 应用数；
- 活跃用户数；
- 会话数；
- 错误数。

待处理区域：

- 待上线版本；
- 发布失败；
- 运行异常；
- 即将过期的 Launch Key；
- 已停用应用。

应用列表字段：

- 应用名称；
- 所属 Agent；
- 状态；
- 线上版本；
- 待上线版本；
- 访问模式；
- Origin 数量；
- 最近发布时间；
- 用户数、会话数和错误数。

应用详情页签：

1. 概览：状态、Agent、publicAppId、线上版本、统计、Embed URL。
2. 版本与上线：待上线版本、历史版本、配置 Diff、预览、上线和回滚。
3. 应用配置：名称、主题、欢迎语、Origin、访问模式及功能配置。
4. 接入方式：iframe、SDK、anonymous 与 signed-user 示例。
5. Launch Keys：登记、有效期、轮换状态和吊销。
6. 用户会话：当前应用的用户 Conversation 摘要及全局入口。
7. 审计：版本、上线、回滚、停用、Key 和导出操作。
8. Danger Zone：停用、恢复和归档。

### 5.4 用户会话

目标：管理员排查企业用户真实 Conversation。

筛选条件：

- PublishedApp；
- Agent；
- 时间范围；
- Conversation 状态；
- anonymous/signed-user；
- 是否有错误；
- PublishedAppVersion。

会话列表字段：

- 脱敏 Principal 标识；
- 应用；
- 会话标题；
- 固定版本；
- 消息数；
- 状态；
- 最后活动时间；
- 错误数。

会话详情页签：

1. Transcript：用户消息、Assistant 回答、工具调用、引用、附件和错误。
2. Event Log：按 sequence 展示事件类型、时间和 turnId，payload 默认折叠。
3. 运行信息：tenant、应用、版本、Principal 类型、模型、Token、延迟、错误码和 requestId。
4. Summary：摘要、throughSequence、最近上下文范围和自动续接链。
5. 附件：文件、类型、大小、状态、时间和权限检查结果。

允许操作：

- 导出脱敏诊断包；
- 导出完整会话；
- 导出 Transcript；
- 归档会话；
- 查看上一个/下一个延续会话；
- 复制 requestId。

查看具体内容、读取附件和导出均必须写管理审计。

## 6. 发布流程

### 6.1 快捷发布抽屉

管理员从“对话”或“Agent”点击发布后：

1. 展示该 Agent 关联的 PublishedApp 列表。
2. 强制管理员显式选择目标 PublishedApp，不记忆默认应用。
3. 选择一个已保存 AgentRevision。
4. 展示相对当前线上版本的变更摘要。
5. 展示应用名称、publicAppId、访问模式和 Origin。
6. 创建不可变 PublishedAppVersion；此时不影响线上。
7. 创建成功后提供独立预览和上线入口。

如果 Agent 存在未保存修改：

- 发布按钮显示“请先保存”；
- 可以跳转 Agent 配置抽屉；
- 不允许自动把草稿直接发布。

### 6.2 版本内容

PublishedAppVersion 必须整体冻结：

- AgentRevision；
- 模型及能力；
- 主题和欢迎语；
- Origin 白名单；
- accessMode；
- RuntimeSpec 和其他运行配置。

应用配置的任何变化都先产生新版本，不能保存后直接改变线上行为。

Launch Key 是独立安全凭据，不进入版本快照。

### 6.3 独立预览

建议路由：

```text
/preview/:publicAppId
```

预览要求：

- 使用 Embed Web 构建产物；
- 使用短期、一次性 Preview Ticket，不能只靠 query 中的 versionId 授权；
- 固定加载指定未上线版本；
- 显示“预览模式”；
- 不影响当前线上版本；
- 支持文字、附件、语音、Avatar 和实际 iframe 尺寸验证；
- Preview Ticket 不写入 URL、Storage 或日志。

### 6.4 上线、回滚和停用

首期采用单管理员二次确认，不引入审批流。

确认框必须显示：

- 应用名称；
- publicAppId；
- 当前版本；
- 目标版本；
- Origin；
- 影响说明。

每次操作记录管理员、时间、旧值、新值、requestId 和结果。

## 7. 企业网站接入

### 7.1 iframe

```html
<iframe
  src="https://agent.example.com/embed/pub_xxx"
  allow="microphone"
></iframe>
```

### 7.2 JavaScript SDK

SDK 是 iframe 的轻量控制层，不把 Agent Runtime 嵌入宿主页面。

```ts
const assistant = CompanyAgent.create({
  appId: "pub_xxx",
  container: "#assistant",
  launchToken: await getLaunchToken(),
});

assistant.open();
```

SDK 首期提供：

- inline/floating 两种展示；
- open、close、destroy；
- 尺寸同步；
- 主题偏好；
- signed-user Launch Token 初始化；
- ready、error、conversation-created、logout 事件；
- 严格校验 event.source、event.origin 和协议版本。

私钥只存在宿主后端，SDK 只接收短期 Launch Token。

## 8. 用户隔离

所有 Conversation、Event、Attachment 请求必须按以下 scope 校验：

```text
tenantId + publishedAppId + principalId + conversationId
```

越权和不存在统一返回 404，不提供资源存在性 oracle。

### 8.1 anonymous

- iframe 自己生成高熵 visitorId；
- visitorId 存 iframe Origin 的 Storage；
- 服务端按 tenant + app + visitorId 生成不可逆 subject hash；
- 清理浏览器数据或换设备后不保证身份连续。

### 8.2 signed-user

- 企业宿主后端根据已登录员工签发短期一次性 Launch Token；
- Token 绑定 issuer、audience、appId、Origin、externalUserId、iat、exp 和 nonce；
- iframe 通过限定 Origin 的 postMessage 接收；
- externalUserId 不能来自 URL 或普通未签名字段；
- 明文 externalUserId 不写数据库、Token、日志或指标；
- 相同用户跨 PublishedApp 得到不同 Principal。

## 9. 管理员认证与权限

### 9.1 首期认证

- 管理员工作台统一显示解锁页或解锁抽屉；
- Admin Token 只存在内存 Controller；
- 不写 localStorage、sessionStorage、URL、console 或异常；
- 刷新后重新输入；
- 401 立即清空 Token 和所有管理数据；
- 生产环境在内网、VPN 或身份代理之后开放。

### 9.2 权限预留

首期只有 admin，但服务端和前端能力检查按以下权限点组织：

```text
agent.edit
app.publish
app.activate
app.suspend
conversation.inspect
conversation.export
audit.read
```

后续改为企业 SSO + HttpOnly Session 时，不改变页面信息架构和 Control API 业务对象。

## 10. 路由与构建

### 10.1 管理员路由

```text
/                         默认调试对话
/agents                   Agent 列表
/agents/:agentId          Agent 详情
/apps                     应用仪表盘和列表
/apps/:appId              应用详情
/conversations            用户会话
/conversations/:id        用户会话详情
/settings                 管理设置
```

协议常量由 `@earendil-works/pi-protocol` 的 `ADMIN_WORKBENCH_ROUTES` 持有；页面不得复制字符串路由表。界面标签由 `ADMIN_WORKBENCH_TERMS` 持有。

旧路由兼容：

```text
/publishing               → /apps
/publishing/apps/:appId   → /apps/:appId
```

### 10.2 Embed 路由

```text
/embed/:publicAppId       正式企业用户对话
/preview/:publicAppId     管理员版本预览
```

### 10.3 独立构建产物

当前 `web/src/main.tsx` 的路径分支仍静态导入 Admin、内部对话和 Embed 代码，只完成路由隔离。目标结构为：

```text
packages/web/src/admin/main.tsx
packages/web/src/embed/main.tsx

dist/admin/*
dist/embed/*
```

验收要求：

- Admin Web 与 Embed Web 有独立入口和构建命令；
- Embed 构建产物不包含 publishing、Control API、AdminAuthController 或 Admin Token 文案；
- 两个产物可以独立部署、回滚和缓存失效；
- Admin Web 可以部署到 `agent-admin.example.com`；
- Embed Web 可以部署到 `agent.example.com`。

## 11. Session 日志设计

### 11.1 决策

采用 DeepSeek Harness 的“追加式事件日志是唯一事实来源”，但物理存储使用 PostgreSQL，不为每个 Session 持续维护本地 JSONL 文件。

```text
数据库事件行 = 权威逻辑 Session Log
JSONL = 导出格式，以及未来可选的冷归档格式
```

首期不增加 `conversation_segments` 表。

### 11.2 调试与用户会话分离

建议对象：

```text
debug_sessions
debug_session_events

conversations
conversation_events
conversation_summaries
```

两类事件使用相同事件信封和导出基础设施，但权限、归属、留存和 UI 入口分离。

### 11.3 统一事件信封

```ts
interface SessionEventEnvelope {
  eventId: string;
  sessionId: string;
  sequence: number;
  eventType: string;
  schemaVersion: number;
  turnId?: string;
  payload: unknown;
  createdAt: string;
}
```

约束：

- `(sessionId, sequence)` 唯一；
- sequence 从 1 单调递增，删除或归档后不得重新编号；
- sequence 分配、事件插入和 Conversation 计数更新处于同一事务；
- eventId 全局唯一；
- payload 必须可 JSON 序列化；
- 未知必需事件拒绝恢复，除非事件明确标记为可忽略；
- 模型实际看到的输入必须可由 Header、Summary 和事件恢复。

### 11.4 首期事件词汇

```text
conversation/created
turn/start
context/snapshot
user/message
assistant/start
assistant/chunk
assistant/message
tool/call
tool/result
tool/error
attachment/added
citation/updated
turn/end
turn/interrupted
conversation/summary
conversation/rollover
conversation/archived
history/expired
```

流式 chunk 策略：

- `standard`：保存最终 assistant/message，不永久保存所有 chunk；发布应用默认。
- `diagnostic`：保存首 chunk、里程碑和耗时。
- `full`：保存完整 chunk 和工具细节；管理员调试可用。

无论等级如何，最终消息、Turn 结果、工具副作用状态和错误必须可恢复。

### 11.5 大 payload

建议默认限制：

- 单条普通消息：64 KiB；
- 单事件 payload：256 KiB；
- 内联工具结果：128 KiB；
- 超限工具结果和文件内容写对象存储，事件保存 artifactId、字节数和 checksum；
- 附件二进制永不写入 JSON payload。

这些值必须由配置解析提供，不在业务代码中分散硬编码。

敏感信息永不写事件：

- Admin Token；
- Launch Token；
- Access Token；
- Authorization Header；
- Provider API Key；
- Launch Key 私钥；
- 原始 visitorId 和 externalUserId。

## 12. 超长 Conversation

### 12.1 上下文窗口

完整事件继续保存在数据库，模型请求只使用：

```text
Agent System Prompt
+ PublishedAppVersion 配置
+ 可选用户 Memory
+ 最新 ConversationSummary
+ Summary 之后的最近事件
+ 当前输入
```

不得继续使用“固定读取最多 10,000 条事件”作为历史恢复策略。

### 12.2 Summary

`conversation_summaries` 至少包含：

```text
id
conversationId
throughSequence
content
sourceEventCount
sourceBytes
modelId
createdAt
```

Summary 生成要求：

- throughSequence 单调递增；
- 必须落在完整 Turn 边界；
- 保留用户目标、已确认事实、未完成事项、关键工具结果和安全约束；
- 不把未验证模型推断升级为用户事实；
- Summary 失败不删除或覆盖原事件；
- Runtime 恢复读取最新有效 Summary 和其后的事件。

### 12.3 硬上限和自动续接

首期提供可配置上限，建议初始默认：

- `maxConversationEvents = 5000`；
- `maxConversationEventBytes = 20 MiB`；
- `maxConversationTurns = 500`；
- 附件容量单独配置。

达到任一上限：

1. 不接受新的 Turn，但允许当前 Turn 完成。
2. 生成最终 Summary。
3. 追加 `conversation/rollover`。
4. 当前 Conversation 标记只读。
5. 创建新 Conversation。
6. 新 Conversation 记录 `previousConversationId` 并引用最终 Summary。
7. UI 显示“已自动续接到新会话”，并可查看前后链路。

不得在原 Conversation 中静默删除最早事件。

## 13. 日志导出

### 13.1 导出类型

- 脱敏诊断包：默认。
- 完整会话包：二次确认并审计。
- Transcript：面向人工阅读。

### 13.2 一致性快照

导出开始时读取：

```text
throughSequence = conversations.last_event_sequence
```

只导出 `sequence <= throughSequence`，即使导出期间继续产生事件，ZIP 仍保持一致。

### 13.3 ZIP 内容

```text
conversation-conv_xxx.zip
├── manifest.json
├── session.jsonl
├── transcript.md
├── diagnostics.json
└── attachments/
```

`manifest.json` 至少包含：

- exportFormatVersion；
- conversationId；
- tenant 和应用公开标识；
- PublishedAppVersion；
- Principal 类型和脱敏标识；
- throughSequence；
- 导出模式；
- 导出时间；
- 是否包含附件；
- 是否存在前后延续会话。

导出实现必须：

- 从 PostgreSQL 按 sequence 分页读取；
- 边读取边写 ZIP Response；
- 不将完整会话装入单个内存 Buffer；
- 不落服务器本地磁盘；
- 客户端取消时停止数据库、附件和压缩工作；
- 缺失附件或 sequence 缺口时 fail loud，不静默生成不完整完整包；
- 写 `admin.conversation.exported` 审计事件。

## 14. 数据模型变更

### 14.1 conversations 建议新增

```text
event_count bigint not null default 0
event_bytes bigint not null default 0
turn_count bigint not null default 0
latest_summary_sequence bigint not null default 0
previous_conversation_id uuid null
next_conversation_id uuid null
rolled_over_at timestamptz null
```

必须使用带 tenant、app 和 owner 的复合外键或等价约束，防止跨 scope 续接。

### 14.2 conversation_events 建议补齐

```text
event_id uuid
conversation_id uuid
sequence bigint
event_type text
event_schema_version integer
turn_id text null
payload jsonb
payload_bytes integer
created_at timestamptz
```

关键约束：

```text
UNIQUE (conversation_id, sequence)
UNIQUE (event_id)
CHECK (sequence > 0)
CHECK (payload_bytes >= 0)
INDEX (conversation_id, sequence)
```

若现有 schema 已有等价列，使用迁移补齐语义，不创建重复字段。

### 14.3 conversation_summaries

新增表并对 `(conversation_id, through_sequence)` 建唯一约束。Summary 必须通过 Conversation 关联继承 tenant/app/owner scope，不允许按裸 summaryId 越权读取。

## 15. API 工作清单

### 15.1 Agent 管理

需要确认或新增：

```text
GET    /api/control/v1/agents
GET    /api/control/v1/agents/:agentId
PATCH  /api/control/v1/agents/:agentId/draft
POST   /api/control/v1/agents/:agentId/revisions
GET    /api/control/v1/agents/:agentId/revisions
GET    /api/control/v1/agents/:agentId/apps
```

如果继续使用 AgentDefinition 命名，协议与 UI 必须统一映射，不在组件内混用概念。

### 15.2 应用和版本

复用已有 Control API，并补齐：

```text
POST   /api/control/v1/published-apps/:appId/preview-ticket
GET    /api/control/v1/dashboard/summary
GET    /api/control/v1/published-apps/:appId/conversations
```

### 15.3 用户会话排查

管理员 Control API 与 Embed 用户 API 分离：

```text
GET    /api/control/v1/conversations
GET    /api/control/v1/conversations/:conversationId
GET    /api/control/v1/conversations/:conversationId/events
GET    /api/control/v1/conversations/:conversationId/summaries
GET    /api/control/v1/conversations/:conversationId/attachments
POST   /api/control/v1/conversations/:conversationId/export
```

Control 响应默认脱敏，不复用面向 Principal 的 Embed Bearer Token。

### 15.4 自动续接

```text
POST /api/embed/v1/conversations/:conversationId/continue
```

也可由 create Conversation 内部自动处理，但协议必须明确返回旧会话已 rollover 和新 conversationId，客户端不得靠错误文案推断。

## 16. 前端目录建议

```text
packages/web/src/admin/
├── main.tsx
├── app-shell.tsx
├── routes.ts
├── auth/
├── conversation/
├── agents/
├── apps/
├── user-conversations/
├── settings/
└── shared/

packages/web/src/embed/
├── main.tsx
├── embed-app.tsx
├── preview-app.tsx
└── ...existing embed modules
```

迁移原则：

- 先抽出共享纯类型和无权限 UI 原语；
- 不把 PublishingApp 整体嵌进现有 App；
- 将既有 publishing controller/API 迁入 admin/apps 模块；
- Embed 不依赖 admin 目录；
- Admin 和 Embed 可以共享 protocol、主题 token 和经过审查的纯组件，不共享认证 Controller。

## 17. 实施任务

工程师执行时不要只使用本节摘要；独立任务单和依赖矩阵见 [`admin-workbench/tasks/README.md`](./admin-workbench/tasks/README.md)。

### WB-000：冻结路由、术语和契约

交付：

- 本文评审通过；
- UI 术语固定为“对话 / Agent / 应用 / 用户会话”；
- 路由表和重定向冻结；
- 统一 Agent、Revision、PublishedApp、Conversation DTO。

完成条件：

- 旧 `/publishing` 深链接有明确重定向；
- 未识别状态只读显示；
- 所有 API 只使用公开 ID。

### WB-001：拆分 Admin/Embed 构建

交付：独立入口、构建命令、产物和部署说明。

完成条件：

- 两个产物可单独启动；
- Embed 产物静态检查不含管理模块；
- 现有 Embed E2E 不回归。

### WB-002：管理员 App Shell

交付：图标栏、模块侧栏、路由、右侧抽屉和统一解锁态。

完成条件：

- `/` 默认对话；
- 四个核心模块可导航和刷新恢复；
- Admin Token 仍只存在内存；
- 401 全局锁定。

### WB-003：Agent 工作区

交付：Agent 选择器、配置表单、dirty 状态、revision 列表和关联应用。

完成条件：

- 每个 Agent 恢复自己的 DebugSession；
- 未保存草稿不能发布；
- 历史 revision 不可原地修改。

### WB-004：发布抽屉与应用工作区

交付：强制选择应用、版本 Diff、创建版本、应用仪表盘和详情页签。

完成条件：

- 保存、发布、上线分离；
- 修改应用配置只生成待发布变化；
- 再次主动提交生成新 Idempotency-Key。

### WB-005：预览与上线闭环

交付：Preview Ticket、Embed Preview、上线、回滚和停用确认。

完成条件：

- 预览未上线版本不影响线上；
- Ticket 一次性、短期、无 URL/Storage 泄漏；
- 操作审计完整。

### WB-006：用户会话管理

交付：全局列表、筛选、Transcript、Event Log、运行信息、Summary 和附件页签。

完成条件：

- 默认脱敏；
- 查看正文写审计；
- 跨 tenant/app/principal 不可读；
- 大列表和事件按 cursor/sequence 分页。

### WB-007：事件日志补强

交付：统一事件信封、Turn/工具/中断事件、payload 限制和字节计数。

完成条件：

- append 事务更新 sequence、计数和事件；
- 崩溃恢复只追加修复事件，不改写已提交事件；
- 敏感字段测试覆盖。

### WB-008：Summary 与自动续接

交付：Summary 表、生成策略、恢复路径、硬上限和 rollover UI。

完成条件：

- 恢复读取 Summary + 后续事件；
- Summary 失败不丢历史；
- rollover 在完整 Turn 边界发生；
- 前后 Conversation scope 一致且可导航。

### WB-009：日志导出

交付：脱敏、完整和 Transcript 导出；流式 ZIP。

完成条件：

- throughSequence 快照一致；
- 不落本地磁盘；
- 不缓存完整 ZIP；
- 取消能终止后台工作；
- 导出写审计。

### WB-010：企业 SDK

交付：iframe SDK、signed-user 初始化、事件协议和接入文档。

完成条件：

- SDK 不接触私钥；
- postMessage 严格验证；
- iframe 和 SDK 使用同一 Embed 数据面；
- 多宿主 Origin 验收通过。

## 18. 测试与验收矩阵

### 18.1 UI

- `/` 默认进入对话；
- Agent 切换恢复各自 DebugSession；
- 未保存状态刷新提示；
- 发布必须选择应用；
- 四个核心模块刷新可恢复；
- 右侧抽屉在桌面和移动布局可用；
- 空、加载、错误、重试和分页状态完整。

### 18.2 发布

- revision → version → preview → activate 顺序正确；
- 未上线版本不影响新 Conversation；
- 上线后新 Conversation 固定新版本；
- 旧 Conversation 继续固定旧版本；
- 回滚后新 Conversation 使用回滚版本；
- 停用后 exchange 和新 Conversation 被拒绝。

### 18.3 身份隔离

- 100 个 signed-user 各自只能读取自己的 Conversation；
- anonymous visitor 之间隔离；
- 相同 externalUserId 跨 App 不共享 Principal；
- 猜测 conversationId、eventId、attachmentId 均返回统一 404；
- Launch Token 重放失败。

### 18.4 Session 日志

- sequence 并发连续；
- payload 字节计数准确；
- 事件超限在写入点拒绝；
- 完整 Turn 可恢复；
- 中断 Turn 追加 interrupted/unknown-outcome 事件；
- standard 日志仍可恢复最终 Transcript；
- full 日志保留完整调试事件。

### 18.5 Summary 与 rollover

- Summary 只覆盖完整 Turn；
- Runtime 使用 Summary + 后续事件；
- 达到事件、字节或 Turn 任一上限触发续接；
- 当前 Turn 不被硬切断；
- 原 Conversation 变只读；
- 新 Conversation 引用旧 Summary；
- 不删除或重新编号旧事件。

### 18.6 导出

- JSONL sequence 从 1 到 throughSequence 连续；
- 导出期间的新事件不进入当前 ZIP；
- 脱敏导出不含 Token、原始用户标识和私钥；
- 完整导出需要二次确认；
- 附件缺失时完整导出明确失败；
- 大会话导出内存有界；
- 取消下载停止生产；
- 导出操作可在审计中查询。

### 18.7 构建边界

- Embed bundle 不含 admin/publishing 代码；
- Admin bundle 不会在启动时建立 Embed 用户身份；
- 两个产物可独立发布和回滚；
- `/publishing/*` 重定向不会加载旧独立管理 Shell。

## 19. 发布门禁

以下任一项未完成，不得宣称整合发布完成：

1. 真实 Chromium 完成 Admin 解锁 → 选择 Agent → 保存 revision → 选择应用 → 创建版本 → 独立预览 → 上线。
2. 企业宿主以 iframe 完成 anonymous 对话。
3. 企业宿主以 SDK + 真实后端 Launch Token 完成 signed-user 对话。
4. 两个不同用户互相读取 Conversation 返回 404。
5. 旧 Conversation 与新 Conversation 的版本固定行为符合预期。
6. 超长测试会话完成 Summary 和 rollover，不丢失旧历史。
7. 至少一个大会话成功流式导出并验证 JSONL 连续性。
8. Embed 产物确认不包含管理代码和敏感管理文案。

## 20. 实施顺序

推荐顺序：

```text
WB-000
  ↓
WB-001 → WB-002
  ↓        ↓
WB-003 → WB-004 → WB-005
  ↓
WB-007 → WB-008 → WB-006 → WB-009
  ↓
WB-010
  ↓
真实浏览器与宿主闭环验收
```

WB-007/008 先于用户会话完整详情和导出，以避免 UI、恢复和导出分别依赖不同的事件语义。

## 21. 关键禁止项

- 不把旧 PublishingApp 页面以 iframe 或整组件方式塞进管理员对话页。
- 不让 Embed bundle 静态依赖管理模块。
- 不发布未保存 Agent 草稿。
- 不默认记忆发布目标应用。
- 不允许应用配置保存后绕过版本直接生效。
- 不从 URL 或普通 postMessage 字段建立 signed-user 身份。
- 不把明文 externalUserId、visitorId、Token、PEM 或 Provider secret 写入事件、日志或指标。
- 不把 Runtime 内存状态作为唯一事实来源。
- 不为首期 PostgreSQL 事件额外维护同步 JSONL 文件。
- 不增加没有当前冷归档消费者的 Segment 表。
- 不通过固定 10,000 条事件上限假装完成历史恢复。
- 不在 Conversation 超限后静默删除最早事件。
- 不从前端一次性加载或导出完整大会话。
- 不在真实 Chromium 和真实宿主闭环缺失时标记全部完成。
