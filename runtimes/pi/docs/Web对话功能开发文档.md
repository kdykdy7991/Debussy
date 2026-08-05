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
