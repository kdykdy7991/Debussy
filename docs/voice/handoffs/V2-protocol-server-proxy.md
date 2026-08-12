# V2 Handoff: Protocol + Server proxy

状态：Review
日期：2026-08-12
执行者：V2
下游：V3 Client + Web Audio
总规范：[`../PI-STREAMING-SPEECH-SPEC.md`](../PI-STREAMING-SPEECH-SPEC.md)
任务单：[`../tasks/V2-protocol-server-proxy.md`](../tasks/V2-protocol-server-proxy.md)

## 1. 交付摘要

- **Protocol v3 冻结提交** `a242964`：`PROTOCOL_VERSION` 2→3，SpeechJob 契约、
  `start_speech`/`cancel_speech`、`speech_job` 事件、ServerSnapshot 可选 voice
  capability。提交后通知 V3 owner（schema 已冻结）。
- **Pi Server 语音代理**：新增 `server/src/voice/`（client/profiles/speech-manager/
  types）+ `web/speech.ts` browser HTTP PCM proxy + `web/http-shared.ts` 共享鉴权。
- 未配置 voice 时：文字聊天照常、snapshot 不含 voice capability、speech command
  返回稳定 `invalid_state`、不创建任何 voice 资源。
- 真实 V1 联调通过（fake provider 支撑的真实 FastAPI wire），见 §7。

## 2. Protocol v3 schema 表

| 类型 | Schema 名 | 说明 |
| --- | --- | --- |
| `SpeechStatus` | `SpeechStatusSchema` | `queued/generating/streaming/completed/failed/cancelled` |
| `SpeechAudioFormat` | `SpeechAudioFormatSchema` | `encoding: "pcm_f32le"`, `sampleRate ≥ 1`, `channels: 1`（Strict） |
| `SpeechErrorCode` | `SpeechErrorCodeSchema` | 8 个错误码（见总规范 §6.2） |
| `SpeechError` | `SpeechErrorSchema` | `{ code, message }` |
| `SpeechJob` | `SpeechJobSchema` | id/sessionId/messageId/voiceProfileId/status/streamPath/createdAt/updatedAt + 可选 firstChunkAt/audio/error |
| 命令 | `StartSpeechCommandSchema` | `{ command, sessionId, messageId, voiceProfileId? }` |
| 命令 | `CancelSpeechCommandSchema` | `{ command, jobId }` |
| 结果 | `StartSpeechResultSchema` / `CancelSpeechResultSchema` | `{ command, job }` |
| 事件 | `SpeechJobEventSchema` | `{ type: "speech_job", job }` |
| capability | `VoiceCapabilitySchema` | `{ available: true, defaultProfile, profiles?: [{ id, name? }] }`，只含公开 id/name |

- `StrictObject`（`additionalProperties: false`）拒绝一切额外字段；`ResultForCommand`
  对 start/cancel 静态解析到 job-bearing result。
- ServerSnapshot 可选字段 `voice`：缺省（未配置）时客户端隐藏朗读入口。

### 2.1 示例 wire 对象

```jsonc
// start_speech 请求（request envelope）
{ "type": "request", "id": "r1",
  "request": { "command": "start_speech", "sessionId": "s1", "messageId": "a1" } }
// 响应
{ "type": "response", "id": "r1", "ok": true,
  "result": { "command": "start_speech",
    "job": { "id": "j1", "sessionId": "s1", "messageId": "a1", "voiceProfileId": "default",
             "status": "queued", "streamPath": "/api/pi/v3/speech/j1/stream",
             "createdAt": 1, "updatedAt": 1 } } }
// 事件
{ "type": "event", "event": { "type": "speech_job",
  "job": { "id": "j1", "...": "...", "status": "streaming", "firstChunkAt": 2,
           "audio": { "encoding": "pcm_f32le", "sampleRate": 24000, "channels": 1 } } } }
```

### 2.2 版本迁移

- v2 client 发 `hello{version:2}` 到 v3 server → `hello_error{code:"version"}`（现有
  握手逻辑，未做静默降级）。测试：`test/speech-protocol.test.ts` + 既有
  `protocol.test.ts` 的 version 协商。
- 客户端其它消息不兼容行为不变。

## 3. SpeechManager

### 3.1 状态图

```text
queued ──claim──> generating ──first PCM──> streaming ──EOF(%4==0)──> completed
  │                  │                         │
  ├──── TTL/取消 ────┴───────── 取消/断开 ─────┴──────────────> cancelled
  │                  │                         │
  └── 未claim TTL ───┴─── upstream 错误 ───────┴──> failed(error)
```

- 终态不可逆；重复 cancel 幂等返回当前 job。
- 非 owner cancel 返回 `not_found`（不泄漏 job 存在性）。
- `completed` 表示上游耗尽 + server 写完 HTTP response，**不**表示浏览器播放结束。

### 3.2 Ownership / TTL / cleanup 证明

- Job 归创建它的 WebSocket `ConnectionState`；`speech_job` 事件只发 owner。
- 单连接最多一个非终态 Job（再请求 → `busy`）。
- 未 claim 30s → `cancelled`（HTTP 410）；终态保留 5min 后从内存清除。
- abort 幂等：cancel_speech / HTTP response `close` / WS disconnect / shutdown /
  timeout / upstream error 均调用 `AbortController.abort()`；用户取消 → `cancelled`，
  基础设施错误 → `failed`。
- Job 不进入 SessionSnapshot / event log / persistence。
- 测试证明：`test/speech-manager.test.ts`（22 例）+ `test/speech-server.test.ts`
  （15 例，含 claim 409、TTL 410、disconnect/shutdown abort）。

## 4. Browser HTTP API

### 4.1 路由

```http
GET /api/pi/v3/speech/{jobId}/stream
OPTIONS /api/pi/v3/speech/{jobId}/stream
Authorization: Bearer <PI_WEB_TOKEN>
```

### 4.2 成功响应头

| Header | 值 |
| --- | --- |
| `Content-Type` | `application/vnd.pi.pcm` |
| `Cache-Control` | `no-store` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Pi-Speech-Job-Id` | job id |
| `X-Pi-Audio-Encoding` | `pcm_f32le` |
| `X-Pi-Audio-Sample-Rate` | 正整数 |
| `X-Pi-Audio-Channels` | `1` |
| `Access-Control-Expose-Headers` | 上述 `X-Pi-*` 头 |

### 4.3 错误矩阵

| HTTP | code | 场景 |
| --- | --- | --- |
| 401 | `unauthorized` | Bearer 缺失/错误 |
| 403 | `forbidden` | Host/Origin 不允许 |
| 404 | `not_found` | job 不存在 |
| 405 | `invalid_request` | 非 GET/OPTIONS |
| 409 | `speech_stream_claimed` | 已被另一 GET claim |
| 410 | `speech_stream_expired` | 未 claim 已过期/已取消 |
| 502 | `voice_unavailable` | 无法连接 Voice Service / 首包前失败 |

首包后失败：只关闭流 + WS `speech_job(failed)`，绝不切 JSON。

### 4.4 鉴权与 CORS

- 复用 `web/http-shared.ts`（从 uploads 抽取的同一 Host/Origin/Bearer 规则，uploads
  行为零改动，其 145 基线测试不变）。
- 浏览器永远拿不到 `PI_VOICE_TOKEN`；browser 只持 `PI_WEB_TOKEN`。

## 5. Server 配置与 secret 边界

`StartWebServerOptions.voice` / CLI 环境变量：

```bash
PI_VOICE_URL=http://127.0.0.1:18876
PI_VOICE_TOKEN=<server-to-service secret>   # 必需（URL 存在时）
PI_VOICE_DEFAULT_PROFILE=default            # 缺省 "default"
PI_VOICE_PROFILES='[{"id":"default","provider":"qwen3-tts","language":"Chinese","speaker":"Vivian"}]'  # 可选 JSON
```

- 未配置 `PI_VOICE_URL` → 整个 voice 层不创建（无 client/timer/fetch/handler）。
- 默认 profile（内置）：`{ id: "default", name: "Default", provider: "qwen3-tts",
  language: "Chinese", speaker: "Vivian" }`。
- default profile 不在 profiles 列表 → 启动即抛错。
- secret 边界：`PI_VOICE_TOKEN` 只存在于 Node `VoiceServiceHttpClient`（fetch header），
  不跨 browser/WebSocket/protocol；`VoiceCapability` 只含 id/name。

## 6. VoiceServiceHttpClient（voice/client.ts）

- 注入 `fetch`/`now`/`uuid` 便于测试；`openStream` 首包前完成 header 校验 + 首 chunk
  读取，因此首包超时可在 browser 提交前映射为 502。
- 校验：status、`content-type`、`X-Pi-Audio-Encoding`、`X-Pi-Audio-Sample-Rate`、
  `X-Pi-Audio-Channels`。
- 限制：首包 60s / chunk 空闲 30s / 总时长 5min / 最大 100MiB，均可在 options 覆盖。
- 任意网络分块转发；总字节数由 SpeechManager 在 EOF 校验 %4。
- 错误映射：非 2xx / 坏 header / 空输出 → `VoiceUpstreamError`（502）；idle/total/
  max_bytes → `VoiceLimitError`（`speech_generation_failed`）。

## 7. 测试与真实 V1 联调

### 7.1 自动化

```text
protocol: 228 passed（含 speech-protocol 新 42 例）
server:   198 passed（+53：speech-manager 22 / speech-client 13 / speech-server 15 / web-start 3）
client:   46 passed（仅 protocol 兼容改动）
```

覆盖要点：schema 正反例与额外字段、v2/v3 握手、`ResultForCommand` 静态类型、
authoritative text 提取（thinking/toolCall 不泄漏）、ownership/claim/TTL、Host/Origin/
Bearer/OPTIONS、PCM 任意分块原样流转、backpressure/drain、首包前 502 vs 首包后
失败关闭流、cancel/HTTP close/WS disconnect/shutdown 均 abort upstream、
未配置 voice 不影响聊天。

### 7.2 真实 V1 联调（2026-08-12，fake provider 支撑的真实 FastAPI wire）

用 `/tmp` 一次性脚本启动 V1 服务（`create_app(config, service)` 注入
`FakeStreamingProvider`，产出 5×8=40 samples/chunk=160 字节），V2 的
`VoiceServiceHttpClient` + 完整 Pi server 路径打真实端点：

```text
PASS  client parses real V1 audio format        — pcm_f32le/24000/1
PASS  client streams 5 chunks × 8 × 4 = 160 bytes
PASS  bad token maps to VoiceUpstreamError      （V1 401 归一为 502 voice_unavailable）
PASS  ws attach / start_speech / HTTP 200 + PCM headers / 160 bytes / content-type
PASS  cancel_speech → cancelled，stream 终止
ALL INTEGRATION CHECKS PASSED
```

- 真实 GPU warm stream / 断流中途行为以 V1 handoff §6 为准（本环境无 GPU）。
- 正式联调建议再覆盖：warm stream 首包 <1.5s、Python down 时聊天不受影响、中途
  断流后第二个请求正常。

## 8. V3 使用示例

```ts
// start
const { job } = await client.request({ command: "start_speech", sessionId, messageId });
// 监听 job 事件
client.onEvent((event) => {
  if (event.type === "speech_job" && event.job.id === job.id) { /* 更新 UI */ }
});
// 拉流
const res = await fetch(job.streamPath, { headers: { authorization: `Bearer ${PI_WEB_TOKEN}` } });
// cancel
await client.request({ command: "cancel_speech", jobId: job.id });
```

- `job.streamPath` 是 server 生成的相对路径，直接 `fetch(streamPath, { headers })`。
- 事件只发创建连接；播放结束是 web 本地状态，不进协议。
- V3 的 typed `SpeechController` hooks 可基于 `speech_job` 事件 + PCM 流实现。

## 9. 已知风险 / 遗留

- **`npm run check` 目前被 V3 未跟踪在制品文件阻断**（`packages/web/src/features/voice/**`、
  `packages/client/test/speech-client.test.ts` 等的 biome lint error）。V2 的 24 个文件
  biome 全绿；待 V3 提交干净代码后 monorepo check 恢复。`tsgo --noEmit` 同样受 V3
  在制品影响，本次未在仓库全量跑通。
- 指标聚合（Spec §12.1）未实现：仓库无现成 metrics 系统，SpeechManager 保留
  `noteBytes` 等计数，指标导出留作后续。
- `speech_cancelled` 错误码在 schema 中保留，当前实际终态 `cancelled` 不带 error 字段；
  V3 若需区分取消原因可扩展 `error.code`。
- SpeechJob 保留 5min 终态元数据是内存上限；大量快速朗读会短暂积累（无持久化）。
- 取消是合作式：底层 CUDA step 无法立即抢占，语义见 V1 handoff §4。

## 10. Spec 偏离（ADR 记录）

1. **start_speech 校验错误码**：Spec §6.2「创建命令前的错误沿用 ProtocolError」，
   而 `message_not_speakable` 等是 SpeechErrorCode。实现：未建 Job 前用
   `ProtocolError.invalid_request`，并在 `details.speechCode` 携带具体 SpeechErrorCode
   （如 `"message_not_speakable"`），让 V3 能区分文案，同时保持 ProtocolError 边界。
2. **非 owner cancel**：Spec 未规定错误码；实现返回 `not_found`（不泄漏 job 存在性），
   而非暴露 ownership。
3. **HTTP abort 期间 openStream 失败**：job 已被取消（WS cancel / disconnect）时，
   browser response 直接 `destroy()` 且不写 JSON body（WS `speech_job` 事件已带真相），
   避免对已关闭连接写头。
4. **未配置 voice 时 HTTP route**：不注册 speech handler，路由 404（非自定义 JSON）。
   因 start_speech 已稳定失败，browser 实际不会访问该路由。
5. **`npm run check` 的 monorepo 全量**：受并行 V3 在制品影响无法全绿；V2 边界内
   所有验收命令（protocol/server test+build+typecheck、biome on V2 files）通过。

## 11. 验收命令（V2 边界内全部通过）

```bash
# runtimes/pi，Node >=22.19（本环境用 /home/hello/.nvm/versions/node/v22.23.2/bin）
npm run test --workspace=@earendil-works/pi-protocol       # 228 passed
npm run build --workspace=@earendil-works/pi-protocol
npm run test --workspace=@earendil-works/pi-server         # 198 passed
npm run typecheck --workspace=@earendil-works/pi-server
npm run build --workspace=@earendil-works/pi-server
npm run test --workspace=@earendil-works/pi-client         # 46 passed
npx biome check packages/server/src/voice packages/server/src/web/speech.ts \
  packages/server/src/web/http-shared.ts packages/server/src/web/uploads.ts \
  packages/server/src/web/start.ts packages/server/src/web/cli.ts \
  packages/server/src/web/index.ts packages/server/src/testing/backend.ts \
  packages/server/src/types.ts packages/server/src/server.ts \
  packages/server/src/snapshots.ts packages/server/src/sessions.ts \
  packages/server/src/transports/websocket/preset.ts \
  packages/server/test/speech-manager.test.ts packages/server/test/speech-client.test.ts \
  packages/server/test/speech-server.test.ts packages/server/test/web-start.test.ts \
  packages/protocol/src/schemas.ts packages/protocol/test/protocol.test.ts \
  packages/protocol/test/speech-protocol.test.ts packages/client/src/state.ts   # clean
git diff --check
```

## 12. 合并记录

- `a242964` feat(protocol): Protocol v3 冻结（schema + client/server 最小兼容）。
- 本 handoff 对应第二个提交（server proxy），尚未提交；提交信息建议
  `feat(server): 实现 SpeechManager 与 speech HTTP proxy`。
