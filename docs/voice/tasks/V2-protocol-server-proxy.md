# V2 任务单：Protocol + Server proxy

状态：Review
建议执行者：TypeScript protocol / Node server 开发
总规范：[`../PI-STREAMING-SPEECH-SPEC.md`](../PI-STREAMING-SPEECH-SPEC.md)
并行依赖：V1；可先使用 fake Voice Service

## 1. 目标

为 Pi 增加 provider-neutral 的 SpeechJob 控制协议，并在 Pi Server 中实现受鉴权的
browser HTTP PCM proxy。浏览器只能访问 Pi Server；`PI_VOICE_TOKEN` 和 Python 地址
不能跨越 Node 边界。

## 2. 必须阅读

- 总规范第 4–8、10、12–14、18 节
- `runtimes/pi/packages/protocol/src/schemas.ts`
- `runtimes/pi/packages/protocol/src/codec.ts`
- `runtimes/pi/packages/server/src/server.ts`
- `runtimes/pi/packages/server/src/sessions.ts`
- `runtimes/pi/packages/server/src/types.ts`
- `runtimes/pi/packages/server/src/web/start.ts`
- `runtimes/pi/packages/server/src/web/uploads.ts`
- `runtimes/pi/packages/server/src/transports/websocket/**`
- protocol/server 现有 tests 与 testing fixtures
- V1 handoff（真实联调前）

## 3. 允许修改

- `runtimes/pi/packages/protocol/src/**`
- `runtimes/pi/packages/protocol/test/**`
- `runtimes/pi/packages/client` 中仅为 protocol compile compatibility 所需的最小改动；
  不在本任务实现播放 API
- `runtimes/pi/packages/server/src/**`
- `runtimes/pi/packages/server/test/**`
- 上述 package README/CHANGELOG/package metadata（仅必要变更）
- `docs/voice/handoffs/V2-protocol-server-proxy.md`

## 4. 禁止修改

- `services/voice/**`，联调发现问题交回 V1
- `runtimes/pi/packages/web/**`
- `packages/avatar/**`
- 把 PCM 放入 CBOR/WebSocket
- 把 SpeechJob 写入 transcript、session persistence 或 session replay log
- 在 URL query 中放 token
- 让一个 GET 重放/重复消费同一 stream

## 5. Protocol deliverable

将 `PROTOCOL_VERSION` 从 2 升到 3，并实现总规范定义的：

- `SpeechStatusSchema`
- `SpeechAudioFormatSchema`
- `SpeechErrorSchema`
- `SpeechJobSchema`
- `StartSpeechCommandSchema` / result
- `CancelSpeechCommandSchema` / result
- `SpeechJobEventSchema`
- Command、CommandResult、ServerEvent、ResultForCommand union 接线

协议命名使用现有 snake_case command 风格：`start_speech`、`cancel_speech`。
StrictObject 必须拒绝额外字段。

建议在 `ServerSnapshot` 增加可选、provider-neutral 的 voice capability/profile summary，
使 Web 在未配置语音时隐藏入口。不得暴露 speaker、instruct、模型或 Python URL。

### Protocol-only 冻结提交

先独立提交 schema、codec、静态类型和 protocol tests。该提交通过后通知 V3 owner，
后续字段改名视为破坏性变更。

## 6. Server deliverable

新增：

```text
runtimes/pi/packages/server/src/voice/
├── client.ts
├── profiles.ts
├── speech-manager.ts
└── types.ts

runtimes/pi/packages/server/src/web/speech.ts
```

### 6.1 SpeechManager

- Job 使用 `randomUUID()`。
- Job 归 owner WebSocket connection；事件只发 owner。
- 每连接最多一个活动 Job。
- 原子 claim stream；第二个 GET 返回 409。
- 30 秒未 claim 过期；终态保留 5 分钟后清理。
- 状态转换严格遵守总规范，终态不可逆。
- disconnect、detach、shutdown、HTTP close、timeout、cancel 都能 abort。
- Job 不进入 SessionSnapshot/event log/persistence。

### 6.2 权威文本

- 从已 attach session 的权威 runtime snapshot 查 messageId。
- 只接受 `role=assistant && status=complete`。
- 只拼接公开 text parts；thinking/toolCall 不进入请求。
- trim 后为空或超过限制时拒绝。
- SpeechManager 通过最小 resolver callback 获取消息，不直接侵入
  `LiveSessionManager` 内部 map。

### 6.3 Voice Service client

- 使用 Node fetch/stream API，request 带内部 Bearer token。
- 不调用 `arrayBuffer()` 或完整缓存响应。
- 校验 status、content type、encoding、sample rate、channels。
- 支持首包 timeout、idle timeout、总 timeout、最大字节和 AbortSignal。
- upstream 错误转换为安全内部类型，不转发原始 body/stack。
- 可注入 fetch/clock/UUID，测试不访问网络。

### 6.4 Browser HTTP handler

路由：

```text
GET /api/pi/v3/speech/:jobId/stream
OPTIONS /api/pi/v3/speech/:jobId/stream
```

复用 uploads handler 的 Host、Origin、Bearer 和 CORS 规则。输出总规范定义的 PCM headers，
并正确暴露自定义 header。使用 Node backpressure，不全量缓存。

错误 body 统一：

```json
{ "error": { "code": "...", "message": "..." } }
```

首字节后失败只能关闭流并发送 `speech_job: failed`。

### 6.5 Web server wiring

`StartWebServerOptions` 增加可选 voice 配置和依赖注入点。未配置 voice 时：

- 文字聊天完全照常工作。
- server snapshot 不宣称 voice capability。
- speech command 返回明确、稳定的不可用错误。
- 不创建 voice store/timer/fetch。

HTTP handler 需要和 upload handler 组合，不能互相吞掉未知路由。

## 7. 自动化测试

Protocol：

- 所有 schema 正反例和额外字段。
- v2 client 对 v3 server handshake failure。
- codec round trip、增量 frame、ResultForCommand 静态类型。

Server：

- complete assistant message 提取，拒绝其他 item/status/session。
- thinking/toolCall 不泄漏到 fake upstream。
- 默认/未知 profile。
- connection ownership、单活动 Job、状态机、事件 recipient。
- claim race、重复 GET、TTL 与 clock cleanup。
- Host/Origin/Bearer/OPTIONS。
- upstream PCM 任意分块原样流转，Node 不全量 buffer。
- backpressure 和 `drain`。
- 首包前/后错误差异。
- cancel、HTTP close、WS disconnect、detach、shutdown。
- server 未配置/voice down 不影响聊天测试。

## 8. 验收命令

从 `runtimes/pi`：

```bash
npm run test --workspace=@earendil-works/pi-protocol
npm run build --workspace=@earendil-works/pi-protocol
npm run test --workspace=@earendil-works/pi-server
npm run typecheck --workspace=@earendil-works/pi-server
npm run build --workspace=@earendil-works/pi-server
npm run check
git diff --check
```

要求 Node `>=22.19.0`。真实 V1 联调至少覆盖 warm stream、cancel、Python down 和中途断流。

## 9. 交接产物

创建 `docs/voice/handoffs/V2-protocol-server-proxy.md`：

- Protocol v3 schema 表、示例 CBOR 对应对象和版本迁移说明。
- SpeechManager 状态图、ownership、TTL、cleanup 证明。
- Browser HTTP route/header/error 表。
- Server 配置示例，secret 边界。
- fake upstream 用法和真实 V1 联调记录。
- V3 使用的 start/cancel/client event 示例。
- 测试命令与结果、已知风险、spec 偏离。

完成后状态改为 `Review`。未经 review 不让 V3 合入正式接线。
