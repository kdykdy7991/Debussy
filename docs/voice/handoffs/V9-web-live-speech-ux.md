# V9 Handoff: Web Live Speech UX

**状态**: Phase 2 E2E ready（自动化测试已绿；真实 V1 + V8 浏览器验收待 V1 服务部署）
**执行者**: V9 owner
**总规范**: [ [Phase 2 Spec](../PI-LIVE-AGENT-SPEECH-SPEC.md) ]
**任务单**: [ [V9 任务单](../tasks/V9-web-live-speech-ux.md) ]
**日期**: 2026-08-12
**前置**: V5 contract frozen、V8 server coordinator 已实现 + Review/Integration ready

---

## 1. 完成情况总览

| 交付物 | 文件 | 状态 |
| --- | --- | --- |
| Protocol v4 `PromptResult` / `SteerResult` 类型导出 | `packages/protocol/src/schemas.ts` | ✅ |
| Client `SessionPromptOptions.speech` + `SessionHandle.prompt` 返回完整 `PromptResult` | `packages/client/src/session-handle.ts` | ✅ |
| Client `openLiveSpeechStream` helper（识别 204） | `packages/client/src/speech-stream.ts` | ✅ |
| Client `cancelLiveSpeech(jobId)` 幂等 + `getLiveSpeechHandle(id)` lookup | `packages/client/src/client.ts` | ✅ |
| Web `live-settings` 持久化与 capability 检测 | `packages/web/src/features/voice/live-settings.ts` | ✅ |
| Web `AudioContextUnlocker`（共享解锁） | `packages/web/src/features/voice/audio-context-unlocker.ts` | ✅ |
| Web `LivePlaybackController`（复用 V3 AudioPlayer / PcmDecoder） | `packages/web/src/features/voice/live-playback-controller.ts` | ✅ |
| Web `useLiveSpeech` hook（封装生命周期） | `packages/web/src/features/voice/use-live-speech.ts` | ✅ |
| Web `LiveSpeechToggle` 切换 UI（aria-checked、disabled when unavailable） | `packages/web/src/features/voice/live-speech-toggle.tsx` | ✅ |
| Web `LiveStatusRow` 状态行 + 键盘可达 Stop 按钮 | `packages/web/src/features/voice/live-status-row.tsx` | ✅ |
| Web `App.tsx` 接线（prompt 原子带 speech、live/manual 互斥、清理路径） | `packages/web/src/app.tsx` | ✅ |
| Web `SessionController.send` 透传 `speech` 并返回 `{session, liveSpeech?}` | `packages/web/src/lib/session-controller.ts` | ✅ |

**自动化测试**:
- pi-client 70/70（+8 新：openLiveSpeechStream 6 + prompt 自动注册 liveSpeech + cancelLiveSpeech 幂等）
- pi-web 147/147（+31 新：live-settings 8 + audio-context-unlocker 6 + live-playback-controller 10 + live-speech-toggle 3 + live-status-row 4）
- pi-protocol 271/271（未动 schema，仅导出 `PromptResult` / `SteerResult` 类型别名）
- pi-server typecheck 绿（仅消费协议层）
- `npm run check` exit 0（biome + tsgo + typecheck + shrinkwrap + browser-smoke）
- `git diff --check` clean

**未做（依赖外部真实环境）**:
- V1 Voice Service 真实流式 API 上线
- 真实 V8 server + V1 浏览器 E2E（first audible、utterance gap、stop latency、20 turn cleanup）
- Avatar 集成：当前里程碑**故意未挂载**，bridge 保持 `disabled`（V9 §5.3）

---

## 2. Client API

### 2.1 控制面

```ts
// SessionHandle.prompt 现在返回完整 PromptResult（含 liveSpeech）
const result = await handle.prompt("hi", { speech: { mode: "live" } });
// result.session: SessionSnapshot
// result.command: "prompt"
// result.liveSpeech?: LiveSpeechJob   // 仅在 server 真正下发时存在

// 自动注册：result.liveSpeech 已经写入 client.#liveSpeechHandles
// 后续 live_speech_job 事件自动路由到该 handle
const liveHandle = client.getLiveSpeechHandle(result.liveSpeech.id);
liveHandle.subscribe((job) => { /* 状态推进 */ });
```

- `SessionPromptOptions.speech?: LiveSpeechRequest`（v4 frozen，仅 `prompt`，不 ` steer）
- `SessionHandle.prompt` 返回类型由 `SessionSnapshot` 改为 `PromptResult`（破坏性；V3 仅在 pi-client 内部消费）
- `SessionHandle.steer` 同步改为 `SteerResult`（避免 dual return 类型）
- `cancelLiveSpeech(jobId): Promise<void>` — V5 frozen，幂等
- `getLiveSpeechHandle(jobId): LiveSpeechJobHandle | undefined` — 新增 lookup

### 2.2 数据面（`openLiveSpeechStream`）

```ts
const result = await openLiveSpeechStream({
  baseUrl: "http://127.0.0.1:8765",   // 与 WS 同源派生
  streamPath: job.streamPath,          // "/api/pi/v4/live-speech/{jobId}/stream"
  token: webToken,                     // 仅 Authorization header
  signal,
});
if (result === null) {
  // 204 No Content：服务端报告无可朗读文本（Spec §15 / V9 §5.2），视为 ended
  controller.handleNoSpeakable();
  return;
}
const { format, body } = result;      // 与 openSpeechStream 同样的 shape
// format: { encoding: "pcm_f32le", sampleRate: 24000, channels: 1 }
// body:   ReadableStream<Uint8Array>
```

**与 openSpeechStream 的唯一区别**: 204 短路返回 `null`，不抛 `SpeechStreamError`。这是 V8 §10 提到的"无朗读文本"必须识别为正常路径的关键。

---

## 3. Web 状态机

```text
  idle
   │ (useLiveSpeech.preparePrompt 决策)
   ▼
  waiting_for_text   ── item_started assistant ──►  generating   ── 首 PCM 字节 ──►  streaming
                                                                                       │
                                                                                       └─ Server job completed ──►  draining
                                                                                                                       │
                                                                                                                       └─ 最后 AudioBufferSourceNode ended ──►  ended
                                                                                                                       │
  任何时刻：stop() / session change / disconnect / pagehide / unmount ──►  stopped
                                                                                                                       │
  任何 pump 阶段错误（HTTP / PCM / network） ──►  error
```

| 本地状态 | 服务端对应 | UI 文案 | Stop 按钮 |
| --- | --- | --- | --- |
| `waiting_for_text` | `waiting_for_text` | 等待文本 | 可用 |
| `generating` | `generating` | 生成语音 | 可用 |
| `streaming` | `streaming` | 播放中 | 可用 |
| `draining` | `streaming` 但 Server `completed` | 正在结束 | 可用 |
| `ended` | `completed` 且本地 drained | (隐藏) | 隐藏 |
| `stopped` | `cancelled` | 已停止 | 隐藏 |
| `error` | `failed` | 朗读出错 | 隐藏 |

---

## 4. Unlock 策略

```text
用户点击 Send
  └─ useLiveSpeech.preparePrompt()
       ├─ enabled = false       → droppedReason = "user_disabled"   → 走文字 prompt
       ├─ voice.live !== true   → droppedReason = "voice_unavailable" → 走文字 prompt
       └─ 都满足
           └─ AudioContextUnlocker.resume()
               ├─ hasUserGesture = false  → droppedReason = "unlock_failed"
               ├─ create 抛错             → droppedReason = "unlock_failed"
               ├─ resume() reject         → droppedReason = "unlock_failed"
               └─ ok
                   → attachSpeech = true → 在 prompt 中带 speech:{mode:"live"}
```

失败路径调用 `onUnlockFailed(reason)`，App 层显示一次可恢复提示（"浏览器阻止了自动播放，已改用文字模式…"），文字 prompt 仍照常发送。

**关键不变量**（V9 §5.1）:
- 用户**显式开启**才走 unlock 路径；默认关闭。
- 仅 `voice.live === true` 时 toggle 可用（disabled，否则）。
- 服务端能力消失自动降级（toggle 自身仍保留在 localStorage，下一次 snapshot 恢复后仍生效）。
- 失败仅丢 `speech`，不阻塞文字、不 abort Agent。

---

## 5. manual ↔ live 仲裁

`LivePlaybackController.attach()` 在绑定新 handle 前**完整 teardown**（`#teardownPlayback`）。`SpeechController.speak()` 同样先 `#teardownPlayback`。两者**共享**通过 `AudioContextUnlocker.context()` 拿到同一个 `AudioContext`，但每个控制器各自持有：

| 资源 | LivePlaybackController | SpeechController |
| --- | --- | --- |
| `AudioContext` | 通过 `unlocker.context()` 共享 | 通过 `unlocker.context()` 共享 |
| `AudioPlayer` | 私有 | 私有 |
| `PcmDecoder` | 私有 | 私有 |
| HTTP reader / AbortController | 私有 | 私有 |
| Operation token | `#operation` 计数器 | `#operation` 计数器 |
| Late callback 防护 | 比对 operation，否则 no-op | 比对 operation，否则 no-op |

切换语义：
- `manual → live`：speak() 先 teardown 旧 SpeechJob + cancel_speech；live.attach() 创建新 LiveSpeechJob
- `live → manual`：live.stop() 静音本地 + cancel_live_speech；speak() 创建新 SpeechJob
- `live → new prompt`：live teardown 不 abort Agent（V9 §5.2 mutex），下一 prompt 的 speech 流程独立
- `manual → new prompt`：speak() 内部 teardown 旧 SpeechJob

---

## 6. 所有 teardown 路径

| 触发 | 调用方 | Controller 行为 |
| --- | --- | --- |
| WS disconnect | `useEffect` on `connectionState === "disconnected"` | `controller.handleDisconnected()` → `stopped` |
| session 切换 | `useEffect` on `sessionId` 变化（render-time ref 比对） | `attachedJobIdRef = undefined`，下一 attach 走新 session |
| pagehide | `window.addEventListener("pagehide", ...)` | `controller.handleSessionChanged()` → `stopped` |
| unmount | `useEffect` cleanup | `controller.dispose()` → `stopped` |
| StrictMode 双 mount | `attachedJobIdRef` 防止重复 attach 同 job.id | idempotent |
| 用户 Stop 按钮 | `LiveStatusRow` onClick | `controller.stop()` → 静音 + abort reader + `handle.cancel()` (cancel_live_speech) |
| Server `failed` | `handleJob("failed")` | `controller.fail(...)` → `error` + hook |
| Server `cancelled` | `handleJob("cancelled")` | `controller.fail(...)` → `error`（除非本地已是 stopped/ended） |
| Server `completed` | `handleJob("completed")` | `state → "draining"`，本地 drained → `ended` + hook |

所有路径收敛到同一个幂等 `#teardownPlayback`：
1. `abort.abort()`（reader signal）
2. `player?.stop()`（静音所有 active sources）
3. `unsubscribeHandle?.()`（解绑 handle 事件）
4. `handle?.cancel()`（仅 user_stop / completed；其他路径不重复发，server cleanup 已发）
5. 清 timer / drainWaiter / decoder / reader / player / handle

无 listener / reader / AudioNode / fetch 泄漏。

---

## 7. App.tsx 接线

```tsx
// App 主组件
const client = (connection as { client?: SpeechControllerSource & { getLiveSpeechHandle?: ... } }).client;
const live = useLiveSpeech({
  snapshot: client?.snapshot,
  baseUrl,
  token: webToken,
  sessionId: sessionSnapshot.activeSessionId,
  connectionState: connectionSnapshot.state,
  onUnlockFailed: (reason) => setLiveHint(...),   // 一次可恢复 toast
});

// submitMessage
const submitMessage = (event) => {
  event.preventDefault();
  if (!message.trim() || running) return;
  const attachmentIds = active?.attachments?.map(a => a.id);
  void (async () => {
    const prep = await live.preparePrompt();    // 触发 unlock + 决策
    const baseOptions = attachmentIds?.length ? { attachmentIds } : undefined;
    const options = prep.attachSpeech
      ? { ...(baseOptions ?? {}), speech: { mode: "live" as const } }
      : baseOptions;
    const result = await sessions.send(message, options);  // 透传 + 返回 liveSpeech
    setMessage("");
    if (result.liveSpeech && client?.getLiveSpeechHandle) {
      const handle = client.getLiveSpeechHandle(result.liveSpeech.id);
      if (handle) live.bindHandle(handle);                    // 注册并 start
    }
  })().catch(() => {});
};

// 渲染
<Conversation ... livePlaybackState={live.playbackState} onStopLive={live.stop} />
<SessionRail ... liveEnabled={live.enabled} liveAvailable={live.available}
              onLiveEnabledChange={live.setEnabled} />

// 在 TranscriptItemView 中：当前 active assistant item 显示 LiveStatusRow
{liveState !== "idle" ? <LiveStatusRow state={liveState} onStop={onStopLive} /> : null}
```

---

## 8. UI 与错误呈现

- "实时朗读" toggle 默认关闭，位置在 voice section 的 `VoiceSettings` 之后
- toggle aria-checked、role="switch"；不可用时 `disabled` + 文案"服务端未启用 live 朗读能力"
- 不展示内部 profile / provider / error stack
- live 错误**不覆盖 transcript**（`error: LivePlaybackState` 不进入 SessionSnapshot）
- live 错误**不阻止** abort / steer / 下一 prompt（错误只更新本地 playbackState）
- 完成消息保留 Phase 1 手动朗读按钮（`SpeechButton`）；live 与 manual 互斥由 controller attach/stop 调度
- Stop 按钮 aria-label="停止实时朗读"，aria-keyshortcuts="Escape"（V9 §5.3 强制键盘可达）
- unlock 失败提示一次性 liveHint banner（`<output aria-live="polite">`），手动关闭按钮，不污染 transcript
- **Avatar bridge 不挂载**：V9 故意不引入 `@skdy/avatar`（任务单 §5.3 + Spec §4）；`audioLevel` 等 V4 hooks 不再被 live 路径消费

---

## 9. 测试矩阵执行结果

### 9.1 pi-client（70/70）

- `openSpeechStream`（原有 6）
- `openLiveSpeechStream`（新增 6）: 204 → null、200 → format/body、bearer header、cross-origin reject、410 → http_error、network → network_error
- `PiClient.startSpeech`（原有 4）
- `PiClient.liveSpeech (V9)`（新增 2）: prompt 带 speech、result.liveSpeech 自动注册、cancel_live_speech 幂等
- `state` / `sessions` / `disposal` / `connection` / `unix`（原有，无回归）
- `requests`（原有）

### 9.2 pi-web（147/147）

- `live-settings.test.ts`（8）: 默认 off、持久化、删除能力、`isLiveAvailable` 4 路径、`shouldRequestLiveSpeech` 4 路径
- `audio-context-unlocker.test.ts`（6）: 创建/恢复、idempotent、no gesture、resume rejected、create failed、release
- `live-playback-controller.test.ts`（10）: streaming 触发 stream、204 → ended（no error）、stop → cancel handle、session change teardown、late job 事件忽略（operation token）、disconnect 无 cancel、failed → error、intruder job id ignore、dispose 幂等
- `live-speech-toggle.test.tsx`（3）: switch aria-checked、voice.live=false disabled、voice=undefined disabled
- `live-status-row.test.tsx`（4）: idle/ended 不渲染、四 phase 文案、Stop button aria-label、render 无 throw
- 原有 V3 audio-player / pcm-stream / speech-controller / speech-button / voice-settings / session-controller / connection-controller / avatar-speech-bridge / app（无回归）

### 9.3 protocol（271/271，无回归）

### 9.4 server（typecheck 绿，无回归）

---

## 10. 验收命令

```bash
cd runtimes/pi
PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"

npm run test --workspace=@earendil-works/pi-client            # 70 passed
npm run typecheck --workspace=@earendil-works/pi-client        # clean
npm run build --workspace=@earendil-works/pi-client            # clean
npm run test --workspace=@earendil-works/pi-web                # 147 passed
npm run typecheck --workspace=@earendil-works/pi-web           # clean
npm run build --workspace=@earendil-works/pi-web               # clean (530.65 kB)
npm run check:browser-smoke                                   # clean
npm run check                                                 # exit 0
git diff --check                                              # clean
```

---

## 12. 已知风险与决策

| 风险 | 决策 |
| --- | --- |
| `LivePlaybackController` 内部清理与 V8 server 清理重复 cancel | 只在 `user_stop` / `completed` 时通过 `handle.cancel()` 发 cancel_live_speech；disconnect / session change / aborted 路径不发（让 server cleanup 走 V8 §9 路径） |
| `AudioContext` 在 SSR / test 环境不存在 | `unlocker.resume()` 检测 `hasUserGesture` 与 `globalThis.AudioContext` 可用性；测试环境注入 fake context 工厂 |
| StrictMode 双 mount 导致 double attach | `attachedJobIdRef` 在 `bindHandle` 中幂等拦截；render-time `lastSessionIdRef` reset 同 job-id 不重复 |
| `PromptResult` 类型破坏 SessionHandle.prompt 返回值 | 任务单 §4 要求；更新 pi-client 唯一调用者（session-controller.ts）+ test/session-controller.test.ts + test/state.test.ts（仅 1 处断言需要修改） |
| `useLiveSpeech` 重 render 时 `bindHandle` 可能收到过期 handle | V9 web 总是从 `client.getLiveSpeechHandle(job.id)` 拉最新 handle；同 session 内重复 attach 用 `attachedJobIdRef` 拦截 |
| Vite build 提示 chunk > 500 kB | 既有 chunk（包含 pi-client 全部），非 V9 引入；v8 handoff 记录 |
| 浏览器 autoplay 真实行为 | task 单 §5.1：unlock 失败仍 prompt，文字照常；V9 fake test 验证 happy path + 3 失败路径，真实浏览器待 V1/V8 联调 |
| 真实 `LiveSpeechJob` 通过 CBOR 反序列化的 wire 形态 | 自动化 fake；真实 wire 测试在 V8 server handoff §11 已覆盖 |

---

## 13. 冻结范围 / 交接

- `LiveSpeechJobHandle` / `cancelLiveSpeech` / `getLiveSpeechHandle` / `openLiveSpeechStream` 公开 API 在 V9 冻结；V8/V10+ 不反向修改
- `useLiveSpeech` hook 内部状态机 (`preparePrompt` / `bindHandle` / `stop` / `handleSessionChanged`) 在 V9 冻结
- `LivePlaybackController` 公共接口（`attach` / `stop` / `handleSessionChanged` / `handleDisconnected` / `dispose` / `subscribe` / `state`）在 V9 冻结
- `LiveSpeechToggle` / `LiveStatusRow` props 在 V9 冻结
- `SessionPromptOptions.speech` + `SessionHandle.prompt` 返回 `PromptResult` 在 V9 冻结
- Protocol 层 `PromptResult` / `SteerResult` 类型别名导出在 V9 冻结（**仅新增导出，不破坏 schema**）

## 14. 给后续 owner 的提示

- **V10+ 真实 E2E**：用 V1 真实 Voice Service + V8 server coordinator 联调，按 Phase 2 Spec §17 七场景跑：300-800 字回答在完整结束前开始说话、3 utterance 顺序、Markdown 投影、Stop<500ms、abort/steer 旧语音、20 turn 无泄漏、Voice down 时文字 + Phase 1 手动朗读不崩溃
- **V4 Avatar**：当 `@skdy/avatar` 上线时，把 `LivePlaybackController.onAudioLevel` 接到现有 `audio-level`；hook 不需要改
- **Performance**：Vite bundle 530 kB（gzip 157 kB）有空间做 manual/live dynamic split；非当前里程碑
- **Voice Service 切换为更快速 TTS**：将 `openLiveSpeechStream` 替换为更快的 transport（WebRTC?），helper 接口稳定