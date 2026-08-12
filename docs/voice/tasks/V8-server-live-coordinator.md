# V8 任务单：Server Live Speech Coordinator

状态：Review / Integration ready
职责：Agent progress → projector → segmenter → queue → browser PCM  
总规范：[`../PI-LIVE-AGENT-SPEECH-SPEC.md`](../PI-LIVE-AGENT-SPEECH-SPEC.md)

## 1. 依赖门槛

### Hard prerequisites

- V5 contract frozen and merged。
- V6 projector/segmenter frozen and merged。
- V7 queue frozen and merged。
- Phase 1 V1/V2 自动化测试通过；真实 V1 endpoint contract 已记录。

### Soft prerequisites

- V9 UI 可未完成；用 protocol/HTTP test client 联调。

### Parallel-safe subset

- V5 后可研究 session lifecycle；正式实现不得绕过未冻结 V6/V7。

### Integration gate

- 真实 Voice Service 联调前 V1 应从 Review 批准。
- `voice.live=true` 只能在完整 server contract tests 通过后开启。

### Merge gate

- fake coordinator E2E 与真实 V1 smoke 通过。
- Phase 1 manual speech/server session tests 无回归。
- 未配置/故障 voice 不影响文字 prompt。

## 2. 目标

实现 Phase 2 server orchestration：在 prompt 前原子注册、绑定正确 turn/message、消费权威
text delta、驱动 V6/V7，并通过一个受鉴权 HTTP response 向浏览器持续输出多个 utterance
的 PCM。

## 3. 允许修改

- server voice/live modules、server/sessions 最小 lifecycle boundary
- `server.ts` command dispatch、web/start 与 HTTP handler composition
- server tests/testing fixtures/config docs
- V8 handoff

禁止修改 Voice Service、Web/Avatar、V5 frozen schema、V6/V7 frozen API（问题退回 owner）。

## 4. 核心实现

### 4.1 Prompt transaction

1. Validate owner/session/profile/capacity。
2. Create Job and all resources。
3. Subscribe progress before `runtime.prompt()`。
4. Invoke prompt。
5. Failure rolls back subscription/job/timers/stream。
6. Result includes liveSpeech。

必须有测试证明 listener-before-prompt，且 backend 同步发首 event 时不丢 delta。

### 4.2 Binding/filter

- 使用 prompt operation token 绑定第一 assistant item。
- 保存 turnId/messageId/contentIndex。
- 只投影 matching assistant text delta。
- thinking/tool/其他 turn 被忽略并计安全诊断。
- terminal item flush/close queue；error/abort cancel。

### 4.3 HTTP

- `GET/OPTIONS /api/pi/v4/live-speech/:id/stream`。
- 复用 Phase 1 auth/CORS/Host helpers，不复制漂移逻辑。
- single claim、30s claim TTL、60s first-text timeout、10m max duration、5m retention。
- 第一 PCM format 确定后发 headers；无文本按冻结 contract 返回 204。
- 首字节后失败关闭 response并发 failed event。
- downstream close 取消 Job。

### 4.4 Lifecycle

- 每连接/每 session 一个 live Job。
- `cancel_live_speech` 不 abort Agent。
- Agent abort/steer、detach/disconnect/session removal/shutdown 取消 live。
- 第一版 steer 后不自动重启语音。
- 所有 path 复用幂等 cleanup，清 timer/listener/fetch/queue/response。
- Job event <=4Hz，终态立即发送。
- 未配置 voice 发布 `live=false`，不创建资源。

## 5. 必测矩阵

- prompt 原子创建、prompt failure rollback、同步首 event。
- turn/message/content binding、跨 turn 迟到 event。
- Markdown/delta -> 3 utterance -> 3 upstream -> 1 downstream。
- strict byte order、format mismatch、backpressure。
- empty/no speakable 204。
- claim race/TTL/timeout/retention。
- cancel vs Agent abort/steer 的不同语义。
- HTTP close、WS disconnect、detach、remove、shutdown。
- owner authorization、Host/Origin/Bearer/OPTIONS。
- backlog/Voice failure 不影响 transcript/prompt completion。
- Phase 1 manual speech 与 live mutual capacity。

## 6. 验收命令

```bash
cd runtimes/pi
npm run test --workspace=@earendil-works/pi-protocol
npm run test --workspace=@earendil-works/pi-server
npm run typecheck --workspace=@earendil-works/pi-server
npm run build --workspace=@earendil-works/pi-server
npm run check
git diff --check
```

真实 V1 smoke 记录：3+ utterance、首包、gap、cancel、Voice down、20 turn cleanup。

## 7. 交接

Handoff 包含 prompt transaction 时序图、session boundary、HTTP contract、配置、状态机、
cleanup ownership、fake/real 联调结果、V9 接口示例和 frozen server commit。完成后标记
`Review / Integration ready`。

