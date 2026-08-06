# Web 对话功能开发文档

## 1. 目标

为 Pi 增加浏览器对话界面，并允许前端与后端并行开发。

本阶段目标是单用户、本机部署的 MVP：

- 浏览和创建会话。
- 打开已有会话。
- 发送普通文本消息。
- 流式显示文本、thinking 和工具调用。
- 停止当前生成。
- 切换模型和 thinking level。
- 浏览器刷新或重新连接后恢复权威会话状态。

本阶段不实现：

- 多用户账号系统。
- 公网部署。
- 会话删除、重命名、fork、clone 和 tree。
- 图片及文件上传。
- TUI extension 自定义 UI。
- 项目信任和危险工具的 Web 审批界面。

以上能力需要扩展 protocol v1，放到后续阶段。

### 1.1 当前完成状态

截至 2026-08-06，protocol v1 的本机 Web 对话 MVP 已完成：连接鉴权、会话列表、创建与打开会话、文本 prompt、abort、text/thinking/tool progress、权威 snapshot 恢复及 Editorial/Vision Glass 前端均已落地。

本节“本阶段不实现”描述的是 v1 边界。下一阶段的正式范围、接口和验收标准以第 12 章 protocol v2 规格为准。

## 2. 架构决策

复用仓库现有的实验性远程会话架构：

```text
packages/web（浏览器）
    │
    │ WebSocket，二进制数据
    │ uint32-be 长度 + CBOR payload
    ▼
packages/server WebSocket listener
    │
    ▼
PiServer
    │
    ▼
PiSessionBackend（需要后端实现）
    │
    ▼
AgentSessionRuntime / AgentSession
    │
    ▼
packages/agent 核心 loop
```

不使用旧的 CLI JSONL RPC 作为 Web 主协议，原因如下：

- `packages/protocol` 已提供运行时校验、CBOR 编解码和 framing。
- `packages/client` 没有 Node 专属依赖，可以在浏览器运行。
- `PiClient` 已实现握手、请求关联、snapshot、progress、session lease 和错误处理。
- `PiServer` 已定义传输无关 listener 和 `PiSessionBackend` 边界。

相关包：

- `packages/protocol`：共享 wire schema、类型、CBOR 和 framing。
- `packages/client`：浏览器可用的传输无关客户端。
- `packages/server`：服务端连接管理和会话协议。
- `packages/coding-agent`：AgentSession、资源、模型和会话持久化。
- `packages/agent`：模型与工具核心循环。

## 3. 开发所有权

### 3.1 前端负责人

后续由当前前端开发者负责，修改范围限定为：

```text
packages/web/**
```

如需修改根 `package.json`、`package-lock.json` 或共享 protocol，先与后端负责人确认。

前端负责：

- Web 项目脚手架和构建配置。
- 浏览器 WebSocket `ByteTransport`。
- `PiClient` 生命周期和状态管理。
- 会话列表、聊天页面、输入框和连接状态。
- transcript、thinking、工具调用和错误渲染。
- loading、abort、重连和 snapshot 恢复。
- 前端单元测试和浏览器测试。

前端不负责：

- Coding Agent backend。
- WebSocket 服务端。
- 模型认证、工具权限和文件系统操作。
- session JSONL 读写。

### 3.2 后端负责人

由另一位开发者负责，主要修改范围：

```text
packages/server/**
packages/coding-agent/**     # 仅 backend adapter 所需部分
packages/protocol/**         # MVP 原则上不修改
```

后端负责：

- WebSocket listener。
- WebSocket upgrade 的 Origin、认证和授权检查。
- Coding Agent `PiSessionBackend` 实现。
- `PiSessionRuntime` 到 `AgentSessionRuntime` 的适配。
- durable session 的创建、枚举、打开和独占控制。
- Agent 事件到 protocol snapshot/progress 的转换。
- 服务启动入口、监听地址和配置。
- 资源释放、异常恢复、并发拒绝和服务端测试。

后端不负责：

- 页面布局和视觉样式。
- 浏览器状态管理。
- transcript DOM 渲染。

### 3.3 共享边界

MVP 期间把 `packages/protocol/src/schemas.ts` 的 protocol v1 视为冻结接口。

任何新增命令或字段必须：

1. 先更新本文档。
2. 更新 protocol schema 和导出类型。
3. 后端完成适配和协议测试。
4. 前端再消费新类型。

不得在前后端分别复制一套手写 DTO。

## 4. WebSocket 传输约定

### 4.1 Endpoint

默认开发地址：

```text
ws://127.0.0.1:8765/api/pi/v1/ws
```

可通过前端环境变量覆盖：

```text
VITE_PI_WS_URL
```

生产环境使用：

```text
wss://<host>/api/pi/v1/ws
```

### 4.2 数据格式

WebSocket 只发送 binary frame。每段数据保持现有 protocol 格式：

```text
[4-byte unsigned big-endian payload length][CBOR payload]
```

前端不得把消息转换成 JSON。后端不得去掉四字节 framing。

浏览器连接必须设置：

```ts
socket.binaryType = "arraybuffer";
```

每次收到数据后调用：

```ts
handlers.onData(new Uint8Array(event.data));
```

protocol decoder 支持数据拆分与合并，因此传输层不能假设一个 WebSocket message 必然对应一个 protocol message。

### 4.3 握手

连接建立后，`PiClient` 首帧发送：

```ts
{
  type: "hello",
  version: 1
}
```

服务端必须返回 `hello` 或 `hello_error`。前端不自行实现 protocol hello，交给 `PiClient.connect()`。

### 4.4 鉴权与 Origin

MVP 仅监听 `127.0.0.1`，不得默认监听 `0.0.0.0`。

即使是本机模式，后端仍应：

- 校验 WebSocket `Origin`。
- 限制允许的 Host。
- 拒绝未授权的 upgrade。
- 设置最大 frame 长度和最大待发送字节数。

未来增加账号系统时使用同源 HttpOnly session cookie。浏览器原生 WebSocket 不能可靠设置任意 Authorization header，因此不要把长期 token 放在 URL query 中。

### 4.5 关闭和错误

浏览器 `ByteTransport` 映射规则：

- `message` → `handlers.onData()`。
- 正常 `close` → `handlers.onClose()`。
- 建连失败或异常关闭 → `handlers.onError(Error)`。
- `send()` 必须保持调用顺序，并在连接未打开时拒绝。
- `close()` 必须可重复调用。

`PiClient` 不自动重连。前端负责退避重连，并在成功后重新 acquire 当前 session。

## 5. MVP 协议能力

直接使用 `packages/protocol/src/schemas.ts` 中的命令：

| Command | 前端用途 |
| --- | --- |
| `list` | 刷新会话列表 |
| `create` | 创建会话 |
| `attach` | 打开已有会话 |
| `detach` | 释放当前会话 lease |
| `prompt` | 空闲时发送普通消息 |
| `steer` | Agent 工作中发送 steering 消息 |
| `abort` | 停止当前 Agent 回合 |
| `set_model` | 切换模型 |
| `set_thinking` | 切换 thinking level |

前端通过 `PiClient` 和 `SessionLease` 调用，不直接构造 request envelope：

```ts
const client = await PiClient.connect({ transportFactory });
const session = await client.createSession({ cwd });

await session.prompt("Inspect this project");
await session.steer("Focus on the API layer");
await session.abort();
await session.setModel({ provider: "oneapi", id: "Qwen3.6-35B-A3B-NVFP4" });
await session.setThinking("medium");
```

## 6. 状态和事件规则

### 6.1 Snapshot 是权威状态

`ServerSnapshot` 和 `SessionSnapshot` 是权威状态。

前端必须使用 snapshot 渲染最终状态，包括：

- 会话列表。
- 当前 model 和 thinking level。
- phase。
- transcript。
- queued steer。

`session_progress` 只是低延迟 UI 提示，不能被当作永久状态源。

### 6.2 Progress 用于流式显示

前端处理以下 `TranscriptProgress`：

| Progress | 行为 |
| --- | --- |
| `item_started` | 创建临时消息或工具卡片 |
| `assistant_delta` | 增量追加 text、thinking 或 toolCall 内容 |
| `item_updated` | 替换对应临时 item |
| `item_finished` | 标记完成、错误或中止 |

收到新的 `session_snapshot` 后，应以 snapshot 替换本地 transcript，并清理已经被权威状态覆盖的临时增量。

### 6.3 Session phase

前端按 phase 控制交互：

| Phase | UI 行为 |
| --- | --- |
| `idle` | 显示发送按钮，可调用 `prompt` |
| `turn` | 显示停止按钮，输入提交调用 `steer` |
| `compaction` | 显示压缩状态，可停止 |
| `branch_summary` | 显示分支摘要状态，可停止 |
| `retry` | 显示重试状态，可停止 |

前端不能只根据“是否收到 delta”推测 Agent 是否空闲。

### 6.4 Session lease

聊天页面对当前会话使用 exclusive lease：

```ts
client.acquireSession(sessionId, { mode: "exclusive" });
```

切换会话时先 dispose 旧 lease，再 acquire 新 lease。组件卸载或 client 断开时必须释放 lease。

## 7. 后端实现任务

### B1. WebSocket listener

在 `packages/server` 实现符合 `PiServerListener` 的 WebSocket listener：

- 完成 HTTP upgrade。
- upgrade 完成前校验认证、Origin 和 Host。
- 将 WebSocket binary data 映射为 server byte connection。
- 保证发送顺序和 backpressure。
- 限制单帧大小和待发送队列。
- 正确传播 close/error。
- 提供 transport conformance test。

建议新增公开入口：

```text
@earendil-works/pi-server/websocket
```

### B2. Coding Agent backend

实现 `PiSessionBackend`：

```ts
interface PiSessionBackend {
  listSessions(): Promise<SessionSummary[]>;
  listModels(): Promise<ModelMetadata[]>;
  createSession(options: CreateSessionOptions): Promise<PiSessionRuntime>;
  openSession(sessionId: string): Promise<PiSessionRuntime>;
}
```

要求：

- 使用持久化 `SessionManager`，不能只保存在内存。
- 创建会话时使用 server 分配的 exact ID。
- session ID 查找必须限制在允许的 cwd/session root 内。
- 同一 session 的冲突写操作返回 `session_locked` 或 `busy`，不能静默排队。
- runtime dispose 后取消订阅并释放所有资源。
- 模型和 thinking 变化写入 session。

### B3. Snapshot adapter

将 Coding Agent 状态转换为 protocol DTO：

- session header → `SessionSummary`。
- 当前活动分支 → `SessionSnapshot.transcript`。
- assistant message → `AssistantTranscriptItem`。
- tool call/result → `ToolTranscriptItem`。
- usage → protocol `Usage`。
- Agent 生命周期 → `SessionPhase`。

所有 DTO 必须通过 protocol runtime schema 校验。不要向客户端暴露原始异常对象、绝对密钥路径或环境变量。

### B4. Progress adapter

订阅 `AgentSession` 事件并产生：

- `item_started`。
- `assistant_delta`。
- `item_updated`。
- `item_finished`。
- 必要的权威 `session_snapshot`。

工具参数必须使用 protocol 的 JSON value 约束，并过滤不可序列化值。

### B5. 服务启动

提供开发启动方式，并明确：

- 默认 host：`127.0.0.1`。
- 默认 port：`8765`。
- WebSocket path：`/api/pi/v1/ws`。
- 工作目录 allowlist。
- agentDir、模型和日志位置。
- 优雅退出和活动 runtime 清理。

### B6. 后端测试

至少覆盖：

- WebSocket protocol conformance。
- hello/version mismatch。
- list/create/attach/detach。
- prompt 的 text/thinking/tool 流式事件。
- abort。
- set model/thinking。
- reconnect 后 snapshot 恢复。
- 不存在 session。
- session 独占冲突。
- 非法 CBOR、超大 frame、错误 Origin 和未授权连接。
- 两个不同 session 并发且状态不串扰。

测试必须使用 faux provider，不调用真实模型 API。

## 8. 前端实现任务

### F1. Web 工程

新增独立 workspace：

```text
packages/web/
```

建议使用 TypeScript、React 和 Vite。直接依赖：

```text
@earendil-works/pi-client
@earendil-works/pi-protocol
```

新增外部依赖必须固定精确版本，并按仓库规则更新 lockfile。

### F2. 浏览器 transport

实现 `createWebSocketTransportFactory()`，满足 `ByteTransportFactory`：

- 支持 URL 配置。
- 使用 binary `ArrayBuffer`。
- 连接成功后才 resolve factory。
- 保持 send 顺序。
- 支持 backpressure 上限。
- close/error 只报告一次。
- 支持测试注入 WebSocket factory。

### F3. PiClient 状态层

提供单例 client provider/store：

- `disconnected / connecting / connected / reconnecting`。
- server snapshot。
- 当前 session lease。
- 当前 session snapshot。
- 重连退避和手动重试。
- 页面卸载时 dispose。

不要复制 PiClient 内部 protocol reducer。

### F4. 页面与组件

建议组件结构：

```text
App
├── ConnectionBanner
├── SessionSidebar
│   ├── NewSessionButton
│   └── SessionList
└── ChatPage
    ├── ChatHeader
    │   ├── ModelSelector
    │   └── ThinkingSelector
    ├── Transcript
    │   ├── UserMessage
    │   ├── AssistantMessage
    │   ├── ThinkingBlock
    │   └── ToolCallCard
    └── Composer
        ├── MessageEditor
        ├── SendButton
        └── AbortButton
```

### F5. Transcript 渲染

- 文本按 Markdown 渲染，并过滤危险 HTML。
- thinking 默认折叠。
- toolCall 显示工具名和格式化后的输入。
- tool result 显示 running、complete、error。
- assistant error/aborted 有独立状态。
- usage 在完成后显示，不参与流式文本拼接。
- 长内容需要折叠或虚拟化，避免每个 delta 重绘整个页面。

### F6. 交互规则

- `idle` 时 Enter 调用 `prompt()`。
- 非 `idle` 时提交调用 `steer()`，UI 明确标注为追加指令。
- Shift+Enter 插入换行。
- Abort 始终调用 `session.abort()`，成功后等待权威 snapshot。
- 切换会话期间禁用发送。
- 创建会话时可选择 cwd、model 和 thinking level。

### F7. 前端测试

至少覆盖：

- transport 二进制收发和异常关闭。
- connect/reconnect 状态。
- snapshot 渲染。
- assistant delta 合并。
- snapshot 覆盖临时 progress。
- prompt 与 steer 的 phase 分流。
- abort。
- session lease 切换和释放。
- assistant/tool 的 complete、error、aborted 状态。

前端测试使用 fake transport 或 `packages/server/testing`，不调用真实模型。

## 9. 前后端联调契约

可执行的本地启动、认证配置和验收步骤见 [Web 对话运行与联调指南](Web对话运行与联调指南.md)。

后端向前端交付以下信息：

```text
PI WebSocket URL
允许的 Origin
认证方式
默认 cwd 或 cwd allowlist
maxFrameLength
服务启动命令
```

联调顺序：

1. WebSocket hello 成功，前端显示 server snapshot。
2. `list` 返回已有会话。
3. `create` 返回可用 exclusive lease。
4. `prompt` 产生 progress，最终返回权威 snapshot。
5. 工具调用能显示 running 和 complete/error。
6. `abort` 后 session 回到 `idle`。
7. 刷新浏览器后重新连接并 attach 原会话。
8. 两个会话分别运行，消息与事件不串线。

## 10. MVP 验收标准

满足以下条件才算 Web 对话 MVP 完成：

- 浏览器能连接 PiServer 并完成 protocol v1 握手。
- 能列出、创建和打开持久化会话。
- 能发送消息并实时看到 text、thinking 和 tool progress。
- 完成后显示与服务端 snapshot 一致的 transcript。
- 能停止生成。
- 能切换模型和 thinking level。
- 刷新页面后可以恢复同一会话。
- WebSocket 断开时 UI 不误报消息已发送。
- 同一会话冲突操作被明确拒绝。
- API Key、环境变量和不安全诊断不会发送到浏览器。
- 前后端各自的定向测试和根目录 `npm run check` 通过。

## 11. 后续阶段

MVP 完成后再按优先级扩展 protocol：

1. 会话 rename/delete。
2. fork/clone/tree。
3. 图片和文件附件。
4. 工具执行审批。
5. 项目信任管理。
6. extension Web UI contract。
7. 多用户认证、配额和租户隔离。
8. 微信、小程序和其他渠道适配。

这些渠道应复用同一个服务端 session/protocol 层，只新增各自的消息入口适配器。

## 12. Protocol v2 后端实施规格

本章是 Web 对话下一阶段的后端工作基线。后端应按 12.2 的顺序交付，不要同时修改所有能力。

### 12.1 架构边界

- `packages/protocol` 定义跨端 DTO、命令、事件和运行时校验，是唯一协议来源。
- `packages/server` 负责鉴权、上传、会话编排、事件序号、审批和客户端广播。
- `packages/coding-agent` 负责 AgentSession 适配、工具策略、附件注入、引用采集和持久化。
- 文件二进制不通过会话 WebSocket 传输；使用同一 HTTP server 的上传端点。
- 上传控制、附件引用、解析状态、运行状态和审批仍通过 WebSocket protocol 发送。
- snapshot 继续作为权威状态；progress/event 只负责低延迟更新和断线续传。
- 新字段会使当前 strict schema 无法解析，因此统一升级 `PROTOCOL_VERSION`，不在 v1 DTO 上做隐式兼容。

### 12.2 交付顺序

| 阶段 | 能力 | 前置条件 | 可独立验收 |
| --- | --- | --- | --- |
| P0 | v2 基础、事件序号与恢复 | 无 | 是 |
| P1 | 文件上传与附件 | P0 | 是 |
| P2 | Citation / RAG | P0；可与 P1 并行 | 是 |
| P3 | Agent Run 状态 | P0 | 是 |
| P4 | Tool 审批、停止和重试 | P3 | 是 |
| P5 | 会话重命名、删除、归档、重新生成和分支 | P0 | 是 |

后端第一个开发分支只做 P0。P0 合并并由前端消费后，再开始 P1/P2。

### 12.3 P0：协议 v2 与可靠流式

#### 12.3.1 协议字段

将 `session_progress` 扩展为：

```ts
interface SessionProgressEvent {
  type: "session_progress";
  sessionId: string;
  turnId: string;
  sequence: number;
  progress: TranscriptProgress;
}
```

新增恢复命令：

```ts
interface ResumeCommand {
  command: "resume";
  sessionId: string;
  afterSequence: number;
}

interface ResumeResult {
  command: "resume";
  session: SessionSnapshot;
  replayedThrough: number;
  resetRequired: boolean;
}
```

规则：

- 同一 session 的 `sequence` 必须严格递增；不能按 connection 分配。
- `turnId` 在一次 prompt/steer 引发的 Agent 回合内保持稳定。
- 服务端为每个活动 session 保留有界 replay buffer，默认至少 2,000 个事件或 10 分钟，先达到者淘汰。
- `afterSequence` 仍在 buffer 中时按顺序重放；已淘汰时返回最新 snapshot，并设置 `resetRequired: true`。
- 最终 `session_snapshot` 必须包含 `lastSequence`，前端据此去重。
- 重复 resume 不得重复执行 Agent、工具或持久化写操作。
- 文本 delta 可以在服务端按 50–100ms 或合理字节阈值批量发送，但不得跨 `contentIndex`、`turnId` 或事件类型合并。
- `item_finished` 之前必须发送完同一 item 的 delta；同一 connection 内保持发送顺序。

#### 12.3.2 背压和限制

- 每个 connection 维护待发送字节上限；达到软上限后暂停读取 runtime progress，达到硬上限后以明确错误关闭连接。
- 限制单个 delta、单个 tool output 和单个 snapshot 的编码后大小。
- Tool output 超限时持久化完整结果，协议只返回截断摘要和 artifact 引用。
- 记录被丢弃、合并、重放的事件数量，但日志不得包含用户正文、API Key 或原始敏感工具参数。

#### 12.3.3 修改位置

```text
packages/protocol/src/schemas.ts
packages/protocol/test/protocol.test.ts
packages/client/src/state.ts
packages/client/src/session-handle.ts
packages/client/test/state.test.ts
packages/server/src/sessions.ts
packages/server/src/coding-agent/runtime.ts
packages/server/test/coding-agent-backend.test.ts
packages/server/test/websocket-conformance.test.ts
```

#### 12.3.4 验收

- 人为断开连接后，从最后确认 sequence 继续显示且无重复字符。
- replay buffer 过期时以前端可识别的 reset 结果恢复权威 snapshot。
- 连续 text、thinking、tool event 顺序稳定。
- 慢客户端不会导致进程内存无限增长。
- faux provider 测试覆盖重复 resume、过期 resume、跨 session 隔离和最终 snapshot 对齐。

### 12.4 P1：文件上传与附件

#### 12.4.1 上传通道

新增 HTTP API：

```text
POST   /api/pi/v2/uploads
GET    /api/pi/v2/uploads/:uploadId
DELETE /api/pi/v2/uploads/:uploadId
```

`POST` 使用 `multipart/form-data`，通过 `Authorization: Bearer <PI_WEB_TOKEN>` 鉴权。必须复用 WebSocket 的 Origin、Host 和 cwd allowlist 策略。

默认限制建议：

- 单文件 25 MiB。
- 单次最多 10 个文件。
- 文件名只作为显示元数据，服务端存储名使用随机 ID。
- 禁止客户端提交绝对保存路径。
- MIME 由服务端嗅探并与扩展名交叉校验。
- 上传先写临时文件，校验成功后原子移动到受控目录。
- 中止、失败和过期上传必须清理临时文件。

#### 12.4.2 数据模型

```ts
type AttachmentStatus =
  | "uploading" | "scanning" | "parsing" | "indexing"
  | "ready" | "restricted" | "failed" | "removed";

interface Attachment {
  id: string;
  sessionId?: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  status: AttachmentStatus;
  scope: "turn" | "session";
  createdAt: number;
  pageCount?: number;
  error?: { code: string; message: string };
}
```

新增 WebSocket 命令：

- `attach_upload`：把 ready upload 绑定到 session，设置 `turn` 或 `session` scope。
- `remove_attachment`：解除绑定；引用中的历史元数据保留。
- `prompt` / `steer` 增加 `attachmentIds`，只接受已绑定且 ready 的附件。

新增事件：

- `attachment_snapshot`：单个附件的权威状态。
- `attachment_removed`：附件不可再用于新回合。

#### 12.4.3 处理流水线

```text
uploading → scanning → parsing → indexing → ready
                         └──────────────→ failed
         └─────────────────────────────→ restricted
```

- 每次状态变化持久化后再广播。
- 扫描器、解析器、索引器使用接口隔离，测试注入 fake 实现。
- 模型不支持目标附件类型时，后端应转为安全文本或返回明确错误，不能静默忽略。
- prompt 持久化 attachment ID、文件名、hash 和 scope，不能把临时路径写入 transcript。
- session 删除或附件解绑后，使用引用计数或保留策略清理对象；不得删除仍被历史记录引用的文件。

#### 12.4.4 验收

- 上传、取消、失败重试、删除均可重复调用且结果确定。
- 非法 MIME、超限文件、路径穿越、未授权访问被拒绝。
- 文件 ready 前不能用于 prompt。
- 服务重启后附件状态和 session 绑定仍可恢复。
- 两个 session 不能越权引用对方附件。

### 12.5 P2：Citation / RAG

#### 12.5.1 数据模型

```ts
type CitationStatus =
  | "available" | "verifying" | "stale" | "restricted"
  | "conflict" | "missing";

interface CitationSource {
  id: string;
  status: CitationStatus;
  title: string;
  sourceType: "attachment" | "workspace" | "tool" | "web";
  owner: string;
  updatedAt: number;
  locator?: string;
  excerpt?: string;
  classification?: string;
  uri?: string;
}

interface CitationAnchor {
  id: string;
  messageId: string;
  contentIndex: number;
  startOffset: number;
  endOffset: number;
  sourceIds: string[];
}
```

`SessionSnapshot` 增加 session 级 `citationSources`；assistant item 增加 `citationAnchors`。锚点 offset 以最终 UTF-16 字符串为基准，并且只能指向 text content。

#### 12.5.2 事件与完整性

新增 progress：

- `citation_source_updated`：来源状态或元数据更新。
- `citation_anchor_added`：回答流式过程中新增稳定锚点。

规则：

- source ID 和 anchor ID 在 session 内稳定，不能用数组下标作 ID。
- 引用必须能追溯到检索结果、附件位置或工具 artifact。
- 没有来源支持的内容不生成 citation；前端明确标为模型生成。
- restricted 来源只发送允许展示的元数据，不发送 excerpt 或内部 URI。
- conflict 引用必须同时保留冲突来源，不能只保留模型选择的一方。
- stale 判断由数据源更新时间和策略产生，不能由前端推测。
- 锚点落在尚未完成的流式文本上时，只追加，不回写已经确认的 offset；需要改写时发送新的权威 item snapshot。

#### 12.5.3 后端接口

在 Coding Agent 适配层定义可替换接口：

```ts
interface EvidenceProvider {
  search(query: string, context: EvidenceContext): Promise<EvidenceHit[]>;
  resolve(hitId: string): Promise<CitationSource>;
}
```

第一版至少支持 attachment/workspace/tool 三类来源；Web 搜索不是 P2 的必要条件。

#### 12.5.4 验收

- 点击引用所需的标题、owner、时间、locator、权限状态均来自协议。
- snapshot 恢复后锚点仍定位到相同正文。
- restricted、stale、conflict、missing 均有协议测试。
- 任何引用都能定位到持久化 evidence 记录或明确报告 missing。
- 日志和错误不泄露受限 excerpt。

### 12.6 P3：Agent Run 状态

不要把运行阶段等同于 `SessionPhase`。`SessionPhase` 控制会话能否接收操作；`AgentRun` 描述一次业务执行。

```ts
type RunStatus =
  | "idle" | "active" | "waiting_user" | "waiting_system"
  | "complete" | "partial" | "failed" | "cancelled";

type RunStage =
  | "scoping" | "researching" | "analyzing" | "drafting"
  | "fact_checking" | "reviewing" | "ready";

interface AgentRun {
  id: string;
  sessionId: string;
  status: RunStatus;
  stage: RunStage;
  startedAt: number;
  finishedAt?: number;
  completedSteps: number;
  totalSteps?: number;
  waitingReason?: string;
  failure?: { code: string; message: string; retryable: boolean };
}
```

新增 `run_snapshot` 事件，并将当前 run 放入 `SessionSnapshot`。只有后端确实知道总步骤时才设置 `totalSteps`；禁止生成虚构百分比。

状态机要求：

- terminal 状态为 complete/partial/failed/cancelled。
- waiting_user 必须包含用户可采取的动作 ID。
- waiting_system 必须包含依赖说明和下一次重试时间（如果会重试）。
- abort 成功后落到 cancelled，而不是 complete。
- 回答文本完成不代表 run ready；事实核验和收尾完成后才能进入 ready/complete。

### 12.7 P4：Tool 审批、停止和重试

#### 12.7.1 Tool 状态

扩展 tool item 状态为：

```text
queued / running / waiting_approval / complete / partial / error / cancelled
```

tool item 增加：

- `startedAt`、`finishedAt`、`durationMs`。
- `permissions`：脱敏后的能力和目标范围。
- `retryable`。
- `artifactIds`。
- `approvalId`（需要审批时）。

#### 12.7.2 审批协议

```ts
interface ApprovalRequest {
  id: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  action: string;
  target: string;
  impact: string;
  reversible: boolean;
  requestedAt: number;
  expiresAt?: number;
}
```

新增命令：

- `resolve_approval`：decision 为 `approve_once`、`approve_for_run` 或 `reject`。
- `cancel_tool`：仅对可中止工具有效。
- `retry_tool`：只接受 terminal 且 retryable 的 tool call。

安全规则：

- 审批决定必须持久化到 audit log，再恢复工具执行。
- `approve_for_run` 仅绑定当前 run，不能升级为全局永久授权。
- 重复 decision 返回原结果；不同 decision 冲突返回 `invalid_state`。
- 高风险工具默认拒绝，不能因 Web 客户端断开自动批准。
- Raw input/output 必须按字段脱敏；前端永远不接收 secret。

### 12.8 P5：会话管理

新增命令：

| Command | 行为 |
| --- | --- |
| `rename_session` | 修改显示名，空白名称拒绝 |
| `archive_session` | 从默认列表隐藏，不删除持久化数据 |
| `delete_session` | 仅 idle 且无活动 lease/run 时允许 |
| `regenerate` | 从指定 assistant message 的前一个用户节点创建新分支并运行 |
| `branch_session` | 从指定 transcript item 创建新 durable session |

规则：

- destructive command 必须携带客户端已见 `expectedRevision`，不匹配返回 `conflict`。
- delete 先写 tombstone，再广播 `session_removed`，最后异步清理可回收资源。
- regenerate 不覆盖旧回答；必须形成新分支并保留审计关系。
- branch 返回新 session ID、parent session ID 和 branch point item ID。
- list 支持 `active/archived/all` 过滤和 cursor 分页，不能一次加载无限会话。

### 12.9 错误码扩展

v2 至少增加：

```text
unauthorized
forbidden
conflict
invalid_state
payload_too_large
unsupported_media_type
rate_limited
expired
```

错误消息必须回答三件事：发生了什么、影响什么、客户端能否重试。可重试错误在 details 中提供 `retryAfterMs`，但不得暴露服务端路径、堆栈和敏感参数。

### 12.10 持久化与迁移

- 为 attachment、evidence、run、approval、event sequence 建立独立持久化记录，不塞入单个无限增长 JSON 对象。
- 每条记录带 schema version；读取时显式迁移。
- 写入使用临时文件加原子 rename，或使用具备事务能力的存储。
- 服务启动时清理过期临时上传，但不得扫描和删除 allowlist 外路径。
- v1 session transcript 可只读加载；首次 v2 写入时完成迁移并留下备份。
- 所有 ID 使用服务端生成的 collision-resistant ID。

### 12.11 测试矩阵

除每阶段单元测试外，服务端必须补充：

- protocol：所有新增 schema 的合法/非法样例和 unknown field 拒绝。
- conformance：命令响应、事件顺序、版本不匹配和错误编码。
- security：路径穿越、跨 session 引用、越权审批、MIME 欺骗、超限 payload。
- recovery：进程重启、连接中断、重复命令、事件重放和中断上传清理。
- concurrency：两个 session、两个 upload、审批与 abort 竞争、delete 与 attach 竞争。
- privacy：restricted citation、tool secret 和服务端路径不会进入 wire payload。

测试使用 faux provider、fake scanner/parser/indexer 和临时目录，不调用真实模型、外部搜索或付费 API。

每阶段完成时运行：

```bash
# 在对应 package 根目录运行新增的定向测试
node ../../node_modules/vitest/dist/cli.js --run test/<specific>.test.ts

# 仓库检查
npm run check
```

### 12.12 后端交付清单

每个阶段交给前端联调前必须提供：

- 已合并的 protocol schema 和导出类型。
- 事件时序示例，不用手写另一套 DTO。
- faux provider 或 testing backend 的可复现场景。
- 启动配置、大小限制和安全默认值。
- 成功、空、失败、权限拒绝、取消和恢复用例。
- 定向测试命令及结果。
- changelog `[Unreleased]` 条目。

未满足以上清单时，前端不基于猜测提前实现协议消费。

### 12.13 后端开工任务单

后端现在领取以下任务，不要先做文件上传页面或 Citation UI。

#### BE-P0-1：冻结 v2 schema

- 在 `packages/protocol/src/schemas.ts` 增加 sequence、turnId、lastSequence、resume command/result。
- 将 `PROTOCOL_VERSION` 升级为 2。
- 更新所有 command/result/event union 和导出类型。
- 在 `packages/protocol/test/protocol.test.ts` 覆盖边界值、unknown field、版本不匹配和非法 sequence。

完成定义：protocol 定向测试通过，前后端能直接导入新类型，不存在另建 DTO 文件。

#### BE-P0-2：实现 session 事件日志

- 在 `packages/server/src/sessions.ts` 为每个 live session 分配严格递增 sequence。
- 建立有界 replay buffer，封装 append、replay、expired 判断。
- snapshot 写入 lastSequence。
- disconnect 不清空仍处于保留期的 buffer；runtime dispose 后按策略释放。
- 对同一 event 的多个 connection 广播完全相同的 sequence。

完成定义：两个客户端观察到相同序列；慢客户端和断线客户端不会影响 Agent 执行或无限占用内存。

#### BE-P0-3：实现 resume

- 在 `packages/server/src/sessions.ts` 处理 resume command。
- buffer 命中时顺序重放缺失事件。
- buffer 过期时返回权威 snapshot 和 `resetRequired: true`。
- 处理重复 resume、未来 sequence、负数 sequence 和错误 session ID。

完成定义：断开、重连、重复恢复后最终 transcript 与一次连续连接完全一致。

#### BE-P0-4：更新 client 与测试工具

- 在 `packages/client` 保存每个 session 的最后 sequence，并丢弃重复事件。
- `PiSessionHandle` 暴露 resume 能力或在 attach 流程内部自动恢复；二选一后写入 API 文档。
- 更新 testing backend/faux 场景，使前端可以稳定模拟掉线和重放。

完成定义：client state、server conformance、coding-agent backend 定向测试全部通过。

#### P0 提交拆分建议

1. `feat: define protocol v2 resumable progress`
2. `feat(agent): add session progress replay`
3. `feat: resume client sessions after reconnect`

每个提交必须独立通过相关定向测试。P0 完成后通知前端联调；前端确认恢复链路后，后端再从 P1 文件上传和 P2 Citation 中各开独立分支。
