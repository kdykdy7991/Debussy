# V3 Handoff：Client + Web Audio

**状态**：Review（待真实 Web 联调确认；V4 只消费本文件冻结的 hooks）
**执行者**：V3 owner
**总规范**：[`../PI-STREAMING-SPEECH-SPEC.md`](../PI-STREAMING-SPEECH-SPEC.md)
**任务单**：[`../tasks/V3-client-web-audio.md`](../tasks/V3-client-web-audio.md)
**日期**：2026-08-12

---

## 1. 完成情况总览

| 交付物 | 文件 | 状态 |
| --- | --- | --- |
| typed client 控制面 | `packages/client/src/speech-handle.ts`、`client.ts`、`types.ts` | ✅ 已实现 + 16 测试 |
| HTTP 数据面 helper | `packages/client/src/speech-stream.ts` | ✅ 已实现（同批 16 测试） |
| PCM 解析器（纯逻辑） | `packages/web/src/features/voice/pcm-stream.ts` | ✅ 17 测试 |
| Web Audio 播放器 | `packages/web/src/features/voice/audio-player.ts` | ✅ 21 测试 |
| 播放控制器 | `packages/web/src/features/voice/speech-controller.ts` | ✅ 20 测试 |
| 朗读/停止按钮 | `packages/web/src/features/voice/speech-button.tsx` | ✅ 5 测试 |
| 语音设置 | `packages/web/src/features/voice/voice-settings.tsx` | ✅ 3 测试 |
| App 接线 | `packages/web/src/app.tsx` + `styles.css` | ✅ 2 个应用级测试 |

**测试结果**：pi-client `62/62`；pi-web `114/114`；两者 `typecheck` 绿；pi-web `vite build` 绿；`check:browser-smoke` 绿；`git diff --check` 干净；改动文件 biome check 0 error/0 warning。

**前置状态**：V2 protocol-only contract 已冻结并提交 `a242964`（SpeechJob、start/cancel、speech_job 事件、voice capability）。本任务基于该冻结 schema 实现，未修改 protocol/server/avatar 任何文件。

**已知未完成**：真实浏览器端到端联调（需 V1/V2 的 Server proxy + Voice Service 全部就绪，见 §8）。本任务所有自动化测试使用 fake，不访问真实网络/GPU/声卡。

---

## 2. Client API（`@earendil-works/pi-client`）

### 2.1 控制面

```ts
// 创建 SpeechJob 并返回句柄（事件只投递到创建该 Job 的连接）
const handle = await client.startSpeech({
  sessionId: "session-1",
  messageId: "assistant-1",
  voiceProfileId: "vivian", // 可选，缺省用 server 默认 profile
});

handle.job;                        // 最新 SpeechJob（含 streamPath、audio format）
handle.subscribe((job) => { ... }); // job 状态推进；终态后可安全取消订阅
await handle.cancel();             // cancel_speech；幂等，返回最新 Job
```

- `speech_job` 事件**不进入** `ClientState`（不写 session snapshot / event log），由 `PiClient` 按 `job.id` 路由到对应 handle。
- 终态（`completed`/`failed`/`cancelled`）后 handle 从路由表移除；重复/乱序事件被 `updatedAt` + 终态不可逆规则拦截（`speech-handle.ts#isStale`）。
- 断线/dispose：pending 请求 reject（`PiDisconnectedError`/`PiClientDisposedError`），活动 handle 不再收到事件。

### 2.2 数据面（`openSpeechStream`）

```ts
const { format, body } = await openSpeechStream({
  baseUrl: "http://127.0.0.1:8765", // 与 WS 同源的 HTTP origin
  streamPath: job.streamPath,        // server 生成的相对路径
  token: webToken,                   // 只进 Authorization header
  signal,                            // AbortSignal
});
// format: { encoding: "pcm_f32le", sampleRate: 24000, channels: 1 }
// body:   ReadableStream<Uint8Array>
```

- **streamPath 校验**：必须 server-relative（以 `/` 开头）、非 `//host`、非绝对 URL、且 `new URL(streamPath, baseUrl).origin === baseUrl.origin`。拒绝跨 origin。
- 严格校验 HTTP status 与音频 metadata header（`X-Pi-Audio-Encoding/Sample-Rate/Channels`、`Content-Type: application/vnd.pi.pcm`）。
- 错误 body 有大小上限（1 KiB）；失败映射为 `SpeechStreamError`（`code/status/serverCode`）。
- `fetch` 可注入（结构化 `SpeechStreamFetch`/`SpeechStreamResponse` 接口），Node 传输用户不依赖 DOM。默认回退 `globalThis.fetch`。
- **配置方式**：web 端 `baseUrl`/`token` 由 `app.tsx` 从 WS URL 派生（`deriveSpeechHttpBaseUrl`/`deriveSpeechWebToken`，与 `main.tsx` 的 `httpBaseUrl` 逻辑一致）；HTTP origin 为 WS origin 去掉 `ws(s):` 换 `http(s):`。

---

## 3. Playback 状态机 ↔ Server Job 状态

```text
本地 PlaybackState:  idle -> requesting -> buffering -> playing -> draining -> ended
                                └────── stop / error ──────────────┘
Server SpeechStatus: queued -> generating -> streaming -> completed
                                └────── cancelled / failed ──────┘
```

| 本地状态 | 含义 | 触发 |
| --- | --- | --- |
| `requesting` | 已发送 `start_speech`，等待 Job | `speak()` |
| `buffering` | 已 GET stream，等待首个 PCM 调度 | `ensureStream` 打开 HTTP 流 |
| `playing` | 首个 source 已调度（首声在 lead 后出声） | 播放器 `onStarted` |
| `draining` | Server Job `completed` 且仍有已排队音频 | body EOF **或** `speech_job(completed)` |
| `ended` | 最后一个 `AudioBufferSourceNode` 结束 | 播放器 `onFinished` |
| `stopped` | 用户停止 / session 切换 / 断线 / unmount / pagehide | `stop()`/清理路径 |
| `error` | 可恢复错误 | Job `failed`、stream 失败、autoplay blocked、PCM 损坏 |

- **关键分离**：Server `completed` ≠ 本地播放结束。`draining → ended` 只由本地最后一个 source `ended` 驱动。
- `SpeechJobHandle` 的 `cancelled`（非用户主动停止时）与 `failed` 都进 `error` 状态，显示可恢复错误。

---

## 4. PCM / 缓冲 / underrun / backpressure 算法

### 4.1 PCM 解析（`pcm-stream.ts`）

- 校验 `encoding === "pcm_f32le"`、`sampleRate` 正整数、`channels === 1`（`validatePcmFormat` 接受 `unknown`，因为值来自 HTTP header）。
- 任意网络分块重组：保留不足 4 字节 remainder，与下一 chunk 拼接。
- 显式 little-endian `DataView.getFloat32(offset, true)` 解码；**非有限值抛 `PcmStreamError("non_finite_sample")`**；有限值 clamp 到 `[-1, 1]`。
- EOF 时 remainder 非空 → `PcmStreamError("truncated_stream")`。
- 提供 `push(chunk)` / `take(limit?)` / `end()`；`take` 跨内部缓冲连续 drain。

### 4.2 播放调度（`audio-player.ts`）

- 首个 source 开始时间 = `context.currentTime + firstBufferMs`（默认 **120ms** 初始缓冲）。
- 后续 source 无缝衔接：`nextStartTime = max(nextStartTime, currentTime + safetyLeadMs)`（默认 **60ms**）。
- **underrun**：`nextStartTime < currentTime` 时计数并重建 lead（`underrunCount` 暴露给测试/指标）。
- EOF 进入 draining：`endOfStream()` 后队列清空才 `onFinished`。
- `stop()`/`dispose()` 幂等：detach `onended`、stop 所有 source、清空队列、取消 level loop。

### 4.3 Backpressure（`speech-controller.ts`）

- 目标缓冲默认 **250ms**，最大 **2000ms**（可配置 `targetBufferMs`/`maxBufferMs`）。
- pump 循环：每次 `reader.read()` 前检查 `player.bufferedDuration > maxBufferMs`；超限则 `await waitForBufferBelow(target)`，由播放器 `onBufferConsumed` 触发续读 → 形成 fetch/HTTP backpressure，不整段 `arrayBuffer()`。

### 4.4 audioLevel

- 频率：**每 animation frame 一次**（注入 `requestFrame`/`cancelFrame`），仅播放期间。
- 来源：对最近调度 chunk 的窗口 RMS（窗 128 样本）+ noise gate（0.004）+ 一阶低通（α=0.3）+ clamp `[0,1]`。常量与 V4 `audio-level.ts` 对齐。
- **偏离说明（ADR-001）**：总规范 §11.5 字面写 "从 AnalyserNode 计算 RMS"；V3 改为从已调度 PCM 计算（无 AnalyserNode）。依据 V4 设计稿 §8.1 开放决策推荐模型 1（"V3 推送已计算电平"），仅计算源不同，hook 契约不变。V4 若需 AnalyserNode 采样，`audio-level.ts` 仍保留为回退实现。

---

## 5. 资源所有权与清理路径

| 资源 | 所有者 | 创建时机 | 释放 |
| --- | --- | --- | --- |
| `AudioContext` | `SpeechController`（唯一，V4 不得再造第二份媒体图） | 首次 `speak()`（用户手势路径） | `dispose()`；不主动 close（页面生命周期管理） |
| `AudioBufferSourceNode` | `AudioPlayer` | `feed()` 调度 | `stop()`/`dispose()`/自然 `ended` |
| HTTP fetch + `AbortController` | `SpeechController` | `ensureStream` | stop/session 切换/断线/unmount/`#fail` 均 `abort()` |
| `ReadableStreamDefaultReader` | `SpeechController` | `openSpeechStream` 解析后 | 停止时置 `undefined`（pump 因 operation 变化退出） |
| `SpeechJobHandle` + 订阅 | `SpeechController` | `startSpeech` 后 | teardown/finish 时 `unsubscribe` + `cancel()` |
| level RAF | `AudioPlayer` | 首个 source 调度 | `onFinished`/`stop`/`dispose` 取消 |

**清理入口**（均会停止播放、静音、cancel Job）：
1. `SpeechController.stop()`（按钮"停止"）—— notify 钩子 `onPlaybackEnd("stopped")`。
2. `handleSessionChanged()`（activeId 变化）。
3. `handleDisconnected()`（连接断开）。
4. `dispose()`（App unmount）。
5. `pagehide` 事件。
6. `#fail()`（任何错误）—— 只发 `onPlaybackEnd("error")`。

`#teardownPlayback` 同时 `handle.cancel()`（cancel_speech）+ `abort()` HTTP + `player.stop()`，符合 §8.5 取消传播。

---

## 6. V4 Hooks（冻结契约）

```ts
interface SpeechControllerHooks {
  onPlaybackStart?: () => void;                 // 首个 source 已调度（约 lead=120ms 后出声）
  onAudioLevel?: (level: number) => void;       // 0..1，每 RAF 帧一次，播放期间
  onPlaybackEnd?: (reason: "completed" | "stopped" | "error") => void;
}
```

调用顺序：
1. `speak()` 首包调度 → `onPlaybackStart`。
2. 播放期间每帧 → `onAudioLevel(level)`。
3. 本地播完 → `onPlaybackEnd("completed")`；用户停止 → `onPlaybackEnd("stopped")`；任何失败 → `onPlaybackEnd("error")`。
4. V4 在 `onPlaybackEnd` 内同步做 `setAudioLevel(0)` + `setState("idle")`，再让 UI 宣布 ended/stopped（与 V4 A8 §4 的"最终 0 在 finished resolve 前"一致）。

V4 消费入口：`SpeechController` 公开 `subscribe`/`getState`/`state`/`activeMessageId`/`voice`/`voiceProfileId`/`setVoiceProfile`。`SpeechButton` 与 `VoiceSettings` 各自依赖最小接口（`SpeechButtonApi` / `VoiceSettingsSpeech`），V4 测试可注入 fake。

---

## 7. UI 与错误呈现

- 每条 `complete` assistant 消息，且 `server snapshot.voice` 存在时，显示朗读按钮（`SpeechButton`）。
- 状态：idle →"朗读"；requesting/buffering →"加载中…"；playing/draining →"停止"（`aria-pressed`）。仅 `complete` 显示；thinking/tool/streaming/error/aborted 均不显示。
- 快速切换消息：`speak()` 先 `#teardownPlayback` 取消旧 Job + 停止本地节点，再用 operation 计数保证只留下最后一个。
- 错误可恢复：不破坏 transcript、不阻断发消息；展示安全文案（"无法开始朗读"/"语音服务不可用"/"浏览器阻止了自动播放"/PCM 截断），不暴露上游 stack/token/text。
- 语音设置（`VoiceSettings`）：`voice.profiles.length <= 1` 时显示默认 profile 名；多 profile 时渲染 `<select>`（uncontrolled `defaultValue`，`setVoiceProfile` 更新首选 profile）。已接入 SessionRail。
- 自动播放策略：`AudioContext` 只在 `speak()`（用户手势）创建并 `resume()`；`resume()` 被拒 → 可恢复错误。自动朗读未实现（符合"默认关闭"）。

---

## 8. 真实浏览器验收（待办，阻塞于 V1/V2 全链路）

自动化测试全部 fake，未覆盖真实 GPU/Voice Service/Server proxy。V1/V2 完成后按任务单 §8 手动验收：

1. warm model 在完整生成结束前出声（`首声 < 1.5s` 目标，含 120ms 初始缓冲）。
2. 连续朗读不同消息只有最后一个播放。
3. Stop → 静音 < 500ms，Server Job 进入 `cancelled`。
4. session 切换、刷新、断网不留后台声音/活动生成。
5. Voice Service down 时文本聊天正常，UI 显示可恢复错误。
6. 连续 20 次无 Job/stream/AudioNode/显存泄漏。

**已知未验证项**：
- 真实 `AudioContext` 在 Chrome 的调度/采样率转换行为（fake 已验证算法，未跑真实声卡）。
- autoplay 策略在真实点击手势下的 `resume()`。
- 与 V2 Server proxy 的实际 wire 联调（`streamPath`/metadata header/claim 语义）。
- `voice-settings` 多 profile 在真实 server 配置下的显示。

---

## 9. Spec 偏离 / ADR

| # | 偏离 | 理由与依据 |
| --- | --- | --- |
| ADR-001 | `onAudioLevel` 从 PCM 计算，不用 AnalyserNode | V4 设计稿 §8.1 推荐模型 1（"V3 推送已计算电平"）；hook 契约不变，`audio-level.ts` 保留为 V4 回退实现 |
| — | `VoiceSettings` 提前实现（任务 §6 文件清单要求；规范 §15 Phase D 才"增加 profile 设置"） | 最小实现，未引入自动朗读/性能指标 |
| — | 停止路径同时发 `cancel_speech` + abort HTTP | 规范 §8.5 两者都是 abort 触发；显式 cancel 是 UI 可观察路径 |
| — | 首声 lead 120ms、underrun lead 60ms | 规范 §11.3/§14 给出 80-150ms 目标；60ms 为实现取值，已常量导出便于调整 |

无破坏冻结 schema 的接口变更。

---

## 10. 自动化测试摘要

- **client**（`test/speech-client.test.ts`，16 例）：start/cancel 命令、事件路由、终态 deregister、乱序/终态回退防护、断线/dispose、streamPath/origin/token/header/status/metadata/有限错误 body。
- **web pcm-stream**（17 例）：任意 split point、1/2/3 字节碎片、clamp、NaN/Infinity、截断 EOF、take 限量。
- **web audio-player**（21 例）：lead、无缝衔接、resampling metadata、underrun 重建、EOF→draining→ended、stop/dispose 幂等、level 平滑。
- **web speech-controller**（20 例）：完整状态机、job 事件、stop/session/disconnect/unmount 清理、快速切换、backpressure、错误路径（startSpeech/stream/autoplay/截断）。
- **web UI**（speech-button 5 + voice-settings 3 + app 2）：按钮状态文案/aria、profile 选择、voice capability 存在/缺失时的按钮显隐。

---

## 11. 给 V4 的提示

- 依赖本文件 §6 冻结的 hooks；`SpeechController` 已暴露 `voice`（provider-neutral capability），V4 无需触碰协议。
- `@skdy/avatar` 进 pi-web 依赖、jsdom 决策、`speaking + audioLevel` 测试角色仍按 V4 设计稿 §6/§7 的阻塞项处理。
- 若 V4 用 AnalyserNode 采样电平，`audio-level.ts`（features/avatar）作为回退；否则直接消费 `onAudioLevel`。统一两处电平常量（`LEVEL_*`）是可选重构。
