# Debussy 侧 Voice 接入进度

适用范围: 在 Debussy (`skdy-agent-acceptance`) 内把"发布对话页 -> 同源 Voice WS -> VoxEMW"链路打通。
每个 Task 完成后都必须更新本文件。

## 全局状态

- 当前 Task: Task E3 (DONE) —— Agent visible text → VoxEMW TTS → 浏览器播放
- 下一 Task: 待确认；不要开始 barge-in / Agent cancel / 自动下一轮监听
- 仓库分支: verify/agent-v2-m0-acceptance
- 第一阶段 (Voice Engine Ticket 端点 + realtimeVoice gating) 已完成但未提交,作为本切片前置依赖。

## Task 1 — Voice Engine 服务端配置

Status: DONE

Files changed:
- `runtimes/pi/packages/server/src/embed/voice-engine/config.ts` (new)
- `runtimes/pi/packages/server/test/embed/voice-engine-config.test.ts` (new)

Tests: 6 passed.

## Task 2 — 服务端透明 WebSocket Proxy

Status: DONE

Files changed:
- `runtimes/pi/packages/server/src/embed/voice-engine/proxy.ts` (new)
- `runtimes/pi/packages/server/test/embed/voice-engine-proxy.test.ts` (new)

Tests: 9 passed.

## Task 3 — Proxy wiring 与服务端测试

Status: DONE

Files changed:
- `runtimes/pi/packages/server/src/embed/start.ts` (modified)
- `runtimes/pi/packages/server/src/web/start.ts` (modified)
- `runtimes/pi/packages/server/src/web/cli.ts` (modified)
- `runtimes/pi/packages/server/test/embed/voice-engine-wiring.test.ts` (new)

Tests: 8 passed (wiring) → 26 passed (Task 1+2+3+voice-proxy-ticket).

## Task 4 — Web VoiceEngineTransport

Status: DONE

Files changed:
- `runtimes/pi/packages/web/src/embed/voice-engine-transport.ts` (new)
- `runtimes/pi/packages/web/test/embed/voice-engine-transport.test.ts` (new)

Tests: 8 passed.

## Task 5 — 发布对话页最小 Voice 入口

Status: DONE

Completed:
- 新增 `runtimes/pi/packages/web/src/embed/voice-engine-button.tsx`:纯展示按钮,4 个状态(`disconnected/connecting/connected/closed`)。`connecting` 时 `disabled` 防止双击;`aria-pressed` 与 `aria-busy` 同步状态;含麦克风 SVG 与状态文案。
- `voice-engine-transport.ts` 新增纯函数 `shouldVoiceEngineToggleConnect(status)`:toggle 行为规则——`disconnected/closed` 时请求 connect,`connecting/connected` 时请求 close。这让 UI handler 不依赖 DOM 测试就能验证规则。
- `voice-engine-transport.ts` `connect()` 增加 guard:`if (this.status === "closed") return` 在 `getTicket` await之后,确保 `close()` 在 `connecting` 中被调时不会创建随即被丢弃的 ws。
- `conversation/conversation-composer.tsx`:
  - 新增 prop `voiceEngine?: { status, onToggle }`。
  - 渲染独立 `<div className="composer-voice-engine"><VoiceEngineButton .../></div>`,与既有 `LiveSpeechToggle`(`enableVoice` 路径)互不耦合。
  - 旧 `enableVoice` 默认 false,`SpeechController` 路径保持关闭。
- `app.tsx`:
  - `AppProps` 新增 `enableRealtimeVoice?: boolean` + `voiceEngine?: { status, onToggle }`。
  - `ConversationWorkspace` 接收这两个 prop。
  - Composer 渲染时:`voiceEngine={enableRealtimeVoice ? voiceEngine : undefined}`——gating 在 workspace 层。
- `embed/conversation-workspace-adapter.tsx`:
  - 新增 prop `voiceEngine`,透传到 `<ConversationWorkspace>`。
  - `enableRealtimeVoice={props.voiceEngine !== undefined}`——adapter 自动启用 iff host 传入 voiceEngine。
- `embed/embed-app.tsx`:
  - 新增 state: `realtimeVoiceEnabled`、`voiceStatus`、`voiceTransportRef`。
  - `signInAndLoad` 完成后 `setRealtimeVoiceEnabled(state.features.realtimeVoice === true)`。
  - 在 useEffect 中**预先**构造 `VoiceEngineTransport`(即使当前 realtimeVoice 为 false 也构造,这样 toggle 引用稳定,后续切换 enabled 状态时无需重建)。
  - `voiceEngineToggle` 使用 `shouldVoiceEngineToggleConnect` 决定 connect 还是 close;`token` 从 `controllers.auth.getToken()` 读取。
  - `voiceEngine` prop 通过 `useMemo` 派生,只在 `realtimeVoiceEnabled === true` 时非 undefined。
  - Cleanup 中 `voiceTransportRef.current?.close()` 关闭 transport。

Files changed:
- `runtimes/pi/packages/web/src/embed/voice-engine-button.tsx` (new)
- `runtimes/pi/packages/web/src/embed/voice-engine-transport.ts` (modified: shouldVoiceEngineToggleConnect, close-while-connecting guard)
- `runtimes/pi/packages/web/src/embed/embed-app.tsx` (modified: state, transport, toggle, voiceEngine prop)
- `runtimes/pi/packages/web/src/embed/conversation-workspace-adapter.tsx` (modified: voiceEngine prop, enableRealtimeVoice)
- `runtimes/pi/packages/web/src/conversation/conversation-composer.tsx` (modified: voiceEngine prop, button render)
- `runtimes/pi/packages/web/src/app.tsx` (modified: enableRealtimeVoice + voiceEngine props)
- `runtimes/pi/packages/web/test/embed/voice-engine-button.test.tsx` (new)
- `runtimes/pi/packages/web/test/embed/voice-engine-transport.test.ts` (modified: 2 new tests for shouldVoiceEngineToggleConnect)

Tests:
- 命令:
  ```
  cd runtimes/pi/packages/web && node ../../node_modules/vitest/dist/cli.js --run test/embed/voice-engine-transport.test.ts test/embed/voice-engine-button.test.tsx
  ```
- result: 14 passed (2 files)
- sanity: `test/embed/conversation-workspace-adapter.test.tsx` 4 passed; `test/live-speech-toggle.test.tsx` + `test/speech-button.test.tsx` 8 passed — 无 regression。
- tsc: 新增/修改文件 0 错误。

Decisions made:
- "点击 connect / disconnect"行为验证策略:**纯逻辑 + markup** 双层 — 状态转换用 `shouldVoiceEngineToggleConnect` 纯函数测试,点击 DOM 事件在 Task 6 端到端验收覆盖(避免引入 happy-dom/jsdom + RTL 这个扩大范围的 dep)。
- Transport 在 `useEffect` 中**预先**构造(而非 `realtimeVoiceEnabled` 变 true 时构造),让 toggle 引用稳定;`voiceEngine` prop 在 `realtimeVoiceEnabled === true` 时才非 undefined,与 transport 始终可用解耦。
- `voiceEngineToggle` 的 `getToken()` 调用在 TOKEN_EXPIRED 时抛 `EmbedApiError`;catch 后 transport 已经把 status 推到 `closed`,React 端静默吞掉让 UI 自然显示"已断开"。这是 Task 5 范围最小错误降级——真正的刷新由 `authController.refresh` 路径或宿主重新 init 触发,不在本 Task 内。
- `VoiceEngineButton` 不用 RTL/Testing Library 验证点击;CSS 类仅作展示标记,不写样式表(后续若要正式视觉再单独切片)。

Known issues:
- 无。

Remaining:
- Task 6:端到端链路验收(启动真实 `startWebServer({ publishing, voiceEngine })` + 真实 `VoiceEngineTransport` + 双向透传断言)。

## Task 6 — 端到端链路验收

Status: DONE

Completed:
- 新增 `runtimes/pi/packages/server/test/load/voice-engine-e2e.test.ts`(默认 skip,设 `PI_VOICE_E2E=1` 才跑):
  - 真实 `composeEmbedPlane`(`publishing.enabled=true` + 真实 Postgres/Redis ticket旅游 + 真实 Access Token),不 mock 数据面。
  - 内嵌 `FakeVoxemWUpstream`(mock VoxEMW,独立 `ws` server),代理端 `voiceEngine: { upstreamUrl, upstreamToken }` 指向它,`voiceEngineUpgrade.handleUpgrade` 挂到 `httpServer.on('upgrade')`,同时挂 5 个 HTTP handler(bootstrap/exchange/voiceEngineTicket/attachments/conversations)。
  - 用真实 HTTP 客户端走 Exchange → 拿 access token → 调 `/api/embed/v1/voice-engine/ws-ticket` → `WebSocket`(同源路径 + `?ticket=`)。
  - 5 个断言:① bootstrap 里 `features.realtimeVoice === true`(且 `speech === false`);② ws-ticket 返回一次性 ticket + 相对 `voiceEngineUrl`;③ 无 token 时 ws-ticket 401(gating 在 access-token 层);④ 双向透传 + proxy 不解析 frame(client→upstream `hello-from-client`,upstream→client `pong-from-upstream`,`{"type":"voice.ready",...}` 原样到达 upstream),且 upstream 收到注入的 `Authorization: Bearer <upstreamToken>`;⑤ ticket 复用(重放)→ 错误(403)。
- 新增 `runtimes/pi/scripts/verify-voice-engine-e2e.sh`:一键验收包装(默认 fixture 环境变量 + `PI_VOICE_E2E=1`),沿用仓库既有 `verify-publishing-*` 模式。

Files changed:
- `runtimes/pi/packages/server/test/load/voice-engine-e2e.test.ts` (new)
- `runtimes/pi/scripts/verify-voice-engine-e2e.sh` (new)

Tests:
- 命令:
  ```
  bash runtimes/pi/scripts/verify-voice-engine-e2e.sh
  ```
- result: 5 passed。
- skip 路径:不设 `PI_VOICE_E2E` 时 5 skipped(与现有 load 测试一致)。
- 类型:新增测试文件在 `tsgo --noEmit` 下 0 错误。

Decisions made:
- **用真实数据面而非 mock**。Task 6 是验收,必须戳真实 Postgres/Redis + 真实 `composeEmbedPlane` + 真实 WS 栈,才算是端到端;沿用 `test/load/capacity-load.test.ts` 的 setup 范式。
- **模块化:不直接烧一个 Node 脚本**,而是存成可复用 vitest 测试并配 launch 脚本——这样每次验收/CI 可反复跑,且默认 skip 不拖慢日常。
- 调试中修正的测试自身 bug(非生产代码):`httpCall` 最初忽略 `options.path` 始终请求根路径(导致 404);Exchange 返回字段是 `data.accessToken` 而非 `data.token`(导致 401)。

Known issues:
- **既有(非本切片引入):** `RuntimeSpec.capabilities.realtimeVoice` 被设为必需后,仓库 7 个文件 10 处 `tsgo` 类型错误尚未修复(见下方 Remaining)。本 Task 未碰这些文件。
- 代理不解析 frame:Task 5 已确认 proxy 层不做业务解析,`voice.ready` 原样透传(本 Task 已再次验证)。

Remaining:
- 端到端已在代码级打通。TCU 后续按任务需要:mic capture、AudioWorklet、PCM、ASR/TTS、transcript、barge-in、自动重连、health——均不在本次范围内。
- **需补修既有类型错误**(非本 Task 范围,仅记录):`realtimeVoice` 成为必需字段后这些文件仍缺 `realtimeVoice`/类型不匹配:
  - `packages/server/src/runtime/conversation-runtime.ts`
  - `packages/server/test/debug-conversation-service.test.ts`
  - `packages/server/test/persistence/debug-conversations-integration.test.ts`
  - `packages/server/test/publishing/mcp-runtime-tools.test.ts`
  - `packages/server/test/runtime/conversation-runtime-hydrate.test.ts`
  - `packages/server/test/runtime/conversation-runtime-manager.test.ts`
  - `packages/server/test/runtime/pi-runtime-adapter.test.ts`

Next exact action: 需向用户确认——6 个 Task 已全部完成。若继续,先从修复上述既有 `realtimeVoice` 必需字段导致的类型错误开始(它们会让仓库 `nspeed check`/`tsgo` 不绿)。

## Task E1 — 发布页麦克风 → VoxEMW ASR → asr.final

Status: DONE

Completed:
- 发布页语音入口连接既有 `VoiceEngineTransport` 与 same-origin Voice Proxy；浏览器不接触 VoxEMW 地址或 service token。
- 新增 AudioWorklet 麦克风采集：输入混为 mono，在 worklet 内重采样到 16 kHz、转换 signed PCM16LE，并按 320 samples / 640 bytes（约 20 ms）发送。
- 新增独立 ASR session lifecycle：`asr.start`、连续 `sequence` 的 Base64 `asr.audio`、服务端 VAD 返回的 `asr.final`、重启/退出时 `asr.cancel`。
- `asr.final` 仅保存在当前页面 voice UI state，以 `ASR final: ...` 明确展示；不提交 Agent、不创建 Turn。
- 麦克风拒绝、Voice Service `error`、WS/ticket 失败均离开“正在听”并显示最小错误态。
- final、退出、重启、WS 断开、页面卸载均停止 tracks、断开 AudioWorklet nodes、关闭 AudioContext 并清理 active ASR。

Tests:
- `voice-engine-transport.test.ts`: text event delivery / listener teardown + existing transport lifecycle。
- `voice-asr-session.test.ts`: start/audio sequence、final、cancel/restart/dispose、permission/service/WS errors。
- `voice-engine-button.test.tsx`: listening/final/error debug UI。

Manual acceptance:
1. 配置并启动 VoxEMW voice service 与 Debussy Voice Engine proxy，发布版本启用 `realtimeVoice`。
2. 打开 Published Chat，点击“开启语音模式”，允许麦克风权限。
3. 看到“正在听”后说一句话并停顿，等待 VoxEMW server VAD 收口。
4. 页面应显示 `ASR final: <识别文本>`；Conversation 中不应新增 Turn。
5. 再次点击可开始新 ASR；监听中点击退出后，浏览器麦克风占用应消失。

Checkpoint: E1 complete. Agent Turn、TTS、播放、sentence queue、barge-in 均未开始。

## Task E2 — asr.final 提交到当前 Conversation / Agent Turn

Status: DONE

Completed:
- `VoiceAsrSession` 在 final UI state 中保留对应 `request_id`，没有增加 Voice Turn、Voice Conversation 或身份字段。
- `ConversationWorkspace` 抽取 `submitConversationText`；键盘 form submit 与 ASR final 都调用这一入口，最终复用同一个 `sessions.send`、当前 active Conversation 和既有 Published Chat controller。
- ASR 文本原样提交（仅用 `trim()` 判断是否为空）；VoxEMW 不提供或决定 Conversation、Revision、Principal、Agent 等上下文。
- `submitAsrFinalOnce` 以 ASR `request_id` 去重；只有现有发送入口实际接收后才记录，临时 busy 时允许 workspace state 变化后重试。
- Turn 失败仍走原文本入口的 `.catch()`，把失败文本恢复到 composer；Voice 层没有新增 Turn 错误模型。
- Agent 回复继续由既有 Embed realtime/controller store 更新并由 `AiMessageFlow` 渲染，没有复制 fetch、executeTurn 或 streaming 逻辑。

Tests:
- `voice-asr-submit.test.ts`: 原文透传、同 request 去重、空白过滤、busy 后重试、keyboard → voice → keyboard 共用 caller-owned Conversation。
- `voice-asr-session.test.ts`: final state 携带稳定 request ID，E1 lifecycle 回归。
- E1 transport/button/adapter 回归测试继续通过。

Manual acceptance:
1. 在同一个 Published Chat 中键盘发送第一句并等待 Agent 回复。
2. 开启语音，说第二句并停顿；确认页面显示 ASR final，随后出现相同文本的用户消息和 Agent visible-text 回复。
3. 键盘发送第三句，要求 Agent 复述或关联前两句，确认上下文连续且 Conversation 未切换。
4. 用空白识别结果或重复发送同一个 `asr.final request_id` 的调试帧，确认不新增 Turn。

Checkpoint: E2 complete. TTS、音频播放、sentence buffering、barge-in 均未开始。

## Task E3 — Agent visible text → VoxEMW TTS → 浏览器播放

Status: DONE

Completed:
- 直接观察 Published Chat 已有 `EmbedChatController` 消息 state，只选择 `role=assistant` 的 `text`；`thinking`、tools、system/debug 和 metadata 不进入 TTS。
- 新增最小标点 sentence buffer，遇到 `。！？!?；` 输出完整句；assistant 正常 completed 时 flush 非空尾句。
- 新增串行 TTS session：每句独立 `request_id`，一次仅发送一个 `tts.synthesize`，只在 `tts.completed`（或该请求终态）后推进下一句。
- `tts.audio` Base64 解码后按 `sequence` 重排为 PCM16LE；重复/过期 sequence 被忽略。
- 一个 Web Audio timeline 连续调度所有 16 kHz mono PCM chunk；`tts.completed` 只推进合成队列，不停止已排程音频。
- 退出语音、页面卸载时发送 active `tts.stop`（WS 尚可用时），停止所有播放、清空 sentence buffer/queue 并关闭 AudioContext；WS 断开时做同样本地清理但不发送 stop。
- 没有修改 Agent runtime、Conversation/Turn 协议或 E1 ASR 自动策略。

Tests:
- `voice-sentence-buffer.test.ts`: 跨 delta 简单断句、尾句 flush、clear/空白过滤。
- `voice-tts-session.test.ts`: 两句+尾句严格串行、audio sequence 重排、completed 后继续播放、stop lifecycle、仅 visible assistant text 投影。
- `pcm16-playback.test.ts`: PCM16LE 解码、相邻 chunk 连续时间线调度、播放与 AudioContext 清理。
- E1/E2 transport、ASR、submit、button、adapter 回归继续通过。

Manual acceptance:
1. 启动 VoxEMW voice service 与 Debussy Voice Engine proxy，打开启用 `realtimeVoice` 的 Published Chat。
2. 开启语音并说一句话，等待 `asr.final` 自动进入当前 Conversation。
3. 让 Agent 回复至少两句（例如“第一句。第二句。”），确认文字照常流式显示。
4. 在 WS 调试帧中确认先发送第一句 `tts.synthesize`；收到其 `tts.completed` 后才发送第二句，request ID 各自独立。
5. 确认 `tts.audio sequence=0,1,2...` 连续播放，无逐 frame 明显停顿；completed 到达时已收到的尾部音频仍播放完。
6. 在 TTS 中途退出语音，确认发出 `tts.stop`、声音立即停止且浏览器 AudioContext 被关闭。

Checkpoint: E3 complete. Barge-in、Agent cancel、自动下一轮监听、双工状态机均未开始。

## Task F — Voice MVP 真实端到端验收

Status: DONE

Actual chain verified (2026-09-03):
- Debussy Published Chat 开启语音，经 Vite `/api/voice-engine` WS proxy 到 Debussy same-origin Voice Proxy；浏览器未直连 VoxEMW。
- 真实 microphone PCM16LE/16k/mono 经 VoxEMW Silero server VAD 判停，真实 Qwen3-ASR 0.6B 返回 `asr.final`。
- `asr.final` 复用当前 Published Chat 文本提交路径进入同一 Conversation，Agent visible response 正常显示。
- visible assistant text 按句严格串行送入真实本地 Qwen3-TTS 0.6B，PCM 音频由浏览器连续播放；用户确认完整链路可通。

Real services/models:
- Debussy Published Chat + Debussy Voice Proxy（same-origin `/api/voice-engine/*`）。
- VoxEMW Voice Service：`ws://127.0.0.1:19000/ws`。
- ASR：本地 ModelScope Qwen3-ASR-0.6B-hf；VAD：Silero。
- TTS：与既有 POC 相同的本地 Qwen3-TTS-12Hz-0.6B-Base（torch/bfloat16/Chinese）与 friend clone reference。

Bugs found and minimally fixed:
- Vite dev proxy 未转发 `/api/voice-engine` WebSocket，握手 404；补齐 `ws: true` proxy 与测试。
- VoxEMW 启动脚本默认启动 legacy pipeline/gateway；默认切换到独立 Voice Service，同时保留显式 legacy mode。
- Voice Service 最小配置加载遗漏 `vad`，生产 ASR 静默退化为 manual commit；保留并测试 VAD block。
- Debussy 20ms/320-sample chunk 与 Silero 16k/512-sample inference window 不匹配；服务端跨 chunk 聚合且保留余数。
- VAD 判停到 `asr.final` 之间的同 request 尾部音频被误报 `REQUEST_BUSY`；推理期正常尾帧改为静默丢弃。
- Voice Service ASR 配置误指远程 Hugging Face ID；改为复用 POC 已存在的本地 Qwen3-ASR 模型。
- Voice Service TTS 配置/adapter 误用 VoxCPM2 且遗漏 persona；改为按 backend 选择，并复用 POC 的本地 Qwen3-TTS 与 friend persona。

Remaining / intentional MVP limits:
- 不含 barge-in、用户说话自动打断、Agent Turn cancel、自动下一轮监听、reconnect、partial ASR 或 Avatar。
- 本轮按要求未处理仓库既有、与 Voice MVP 无关的 lint/type errors。

Conclusion: 当前 MVP 已达到“可实际语音对话”：真实说话可触发 ASR、进入当前 Conversation、获得 Agent visible reply，并通过真实本地 TTS 连续播放。Task F checkpoint complete；不开始下一阶段体验增强。

## Task G1 — Published Chat Text / Voice Mode 互斥与显式开关

Status: DONE

Completed:
- Published Chat 默认 `Text Mode`；新增显式“语音模式”开关，进入后显示“语音模式 · <派生状态>”与固定“退出语音”入口，不再把单次 ASR start 当作模式开关。
- Voice Mode 对文本 composer 做 UI + handler + submit 三层门禁：textarea、send、隐藏 file input 与附件入口均 disabled；键盘提交、form submit、change/upload handler 均拒绝文本路径。
- `asr.final` 仍以 `asr` source 复用同一 `submitConversationText`，只有 Voice Mode 可接受；Text Mode 只接受 composer source，两种模式互斥且不创建第二套 Turn 路径。
- Text → Voice 复用既有 transport 并启动一次现有 ASR；未增加自动下一轮监听。
- Voice → Text 统一执行 `asr.cancel`、`tts.stop`（同时停止 playback/关闭播放 AudioContext）、transport close，并清空本地 ASR/TTS UI state后恢复文本输入。
- Voice 状态由现有 transport、ASR、Agent running 与最小 TTS phase 派生：连接中、正在聆听、正在识别、Agent 回复中、正在播放、错误；未增加后端状态机。

Tests:
- `voice-mode.test.ts`: Text/Voice submit source 互斥；退出模式必清 ASR、TTS/playback 与 transport。
- `conversation-workspace-adapter.test.tsx`: 默认 Text Mode textarea 可输入；Voice Mode textarea/file/send 全禁用并显示退出入口。
- `voice-engine-button.test.tsx`: 显式模式、连接/监听/Agent/TTS/error 状态与连接中仍可退出。
- E1–E3 transport/ASR/TTS/audio/sentence/submit 回归继续通过。

Checkpoint: G1 complete. 未实现自动下一轮监听、barge-in、Agent cancel、reconnect，也未修改 VoxEMW 或 Conversation/Turn 后端协议。
