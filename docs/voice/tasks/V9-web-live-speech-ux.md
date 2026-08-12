# V9 任务单：Web Live Speech UX

状态：Blocked（仅 UI/fake 子集可提前）  
职责：live opt-in、AudioContext unlock、连续播放、Stop 与 manual 共存  
总规范：[`../PI-LIVE-AGENT-SPEECH-SPEC.md`](../PI-LIVE-AGENT-SPEECH-SPEC.md)

## 1. 依赖门槛

### Hard prerequisites

- 正式接线必须 V5 contract frozen、V8 Integration ready。
- Phase 1 V3 PcmDecoder/AudioPlayer/SpeechController tests 通过。

### Soft prerequisites

- V8 完成前可用 fake client/stream 开发设置 UI、unlock 和本地状态。

### Parallel-safe subset

- V5 frozen 后可实现纯 UI、local setting、fake LiveSpeechHandle、AudioContext unlock tests。
- 不得在 V8 前猜 route/header/server timing 并合并正式接线。

### Integration gate

- V8 handoff 提供 prompt result、event、cancel、route 和 capability。

### Merge gate

- fake tests、真实 V8/V1 浏览器 E2E、Phase 1 manual regression 全部通过。
- 当前里程碑没有 Avatar import/mount。

## 2. 目标

用户可选择实时朗读；发送 prompt 后 Agent 文字增量显示且第一自然片段形成后开始播放。
Stop 仅停止语音。实时失败时文字继续，并可对完成消息使用 Phase 1 手动朗读。

## 3. 允许修改

- pi-client live handle/helper
- `packages/web/src/features/voice/**`
- Web app/settings/styles/tests
- V9 handoff

禁止修改 Protocol/Server/Voice Service、Avatar、V3 PCM wire semantics。

## 4. Client deliverable

- Prompt API 支持可选 `{speech:{mode:"live",voiceProfileId?}}`。
- 返回/维护独立 `LiveSpeechJobHandle`。
- 路由 `live_speech_job`，updatedAt/terminal 防回退。
- `cancelLiveSpeech()` 幂等。
- v4 stream helper复用 Phase 1 same-origin/Bearer/header/body 限制。
- disconnect/dispose 清理 handle；不依赖 DOM。

## 5. Web deliverable

### 5.1 设置与解锁

- “实时朗读”默认 off，用户显式开启后本地持久化。
- 仅 `voice.live=true` 可开启；能力消失自动回退 off for current session。
- Send click 内先 `AudioContext.resume()`，成功才带 live speech。
- unlock 失败仍发送 prompt，不创建 live Job，显示一次可恢复提示。

### 5.2 播放控制

- 复用一个页面级 AudioContext、PcmDecoder、AudioPlayer。
- 一个 live Job 一个 HTTP reader，utterance 边界透明。
- Job completed/EOF -> draining；最后 node ended -> ended。
- Stop：先本地静音，再 abort reader，再 cancel command；目标 <500ms。
- manual/live/new prompt 互斥，切换前完整 teardown 旧 playback。
- session switch、disconnect、pagehide、unmount 清理。
- late callback 使用 operation token，不能修改新 playback。

### 5.3 UI

- 输出生成期间显示 live 状态：等待文本/生成语音/播放/正在结束。
- Stop button 始终可键盘操作并有 aria-label。
- live error 不覆盖 transcript，不阻止 abort/steer/下一 prompt。
- 完成消息的 Phase 1 手动朗读按钮保留。
- 不展示内部 profile/provider/error stack。
- 不接 Avatar；相关 bridge 保持未挂载。

## 6. 必测矩阵

- capability/live setting/local persistence。
- unlock success/failure，failure 仍 prompt。
- prompt with/without speech payload。
- delayed first utterance、3 utterance single body、draining。
- stop requesting/waiting/generating/playing/draining。
- manual->live、live->manual、new prompt。
- Agent abort/steer event 后本地 stop。
- session/disconnect/pagehide/unmount/StrictMode。
- late handle/reader/audio callback。
- live failed 后 manual works。
- token 仅 Authorization、same-origin route。

## 7. 验收命令与真实 E2E

```bash
cd runtimes/pi
npm run test --workspace=@earendil-works/pi-client
npm run typecheck --workspace=@earendil-works/pi-client
npm run build --workspace=@earendil-works/pi-client
npm run test --workspace=@earendil-works/pi-web
npm run typecheck --workspace=@earendil-works/pi-web
npm run build --workspace=@earendil-works/pi-web
npm run check:browser-smoke
git diff --check
```

真实浏览器验收使用 Phase 2 Spec §17 七个场景，并记录 first audible、utterance gap、stop
latency、20 turn cleanup。Vite bundle warning 不等于失败，但新增体积必须解释。

## 8. 交接

Handoff 写明 Client API、Web 状态机、unlock 策略、manual/live arbitration、所有 teardown、
截图/E2E 指标、测试结果、已知浏览器限制与 spec 偏离。完成后标记 `Review / Phase 2 E2E ready`。
