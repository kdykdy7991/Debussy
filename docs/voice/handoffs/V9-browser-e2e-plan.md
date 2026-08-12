# V9 真实浏览器 E2E 验收计划

## 前置

1. V1 Voice Service 以真实模型运行，healthz 和 stream smoke 通过。
2. V8 Pi server snapshot 返回 `voice.available=true` 和 `voice.live=true`。
3. Pi Web 在普通浏览器窗口运行；保留 DevTools 的 Network 和 Console。

## 场景与通过条件

| 场景 | 操作 | 通过条件 | 记录 |
| --- | --- | --- | --- |
| 首包可听 | 发送要求 300–800 字回答的 prompt | 文本尚在增量显示时听到首句 | Send 到首声延迟 |
| 连续 utterance | 生成至少 3 个句段 | 顺序正确、无重复/截断、无长停顿 | 首声和句段间隔 |
| Markdown | 要求含列表、代码、链接的回答 | 仅朗读投影后的自然文本 | 截图/录音 |
| Stop | 在 waiting/generating/streaming/draining 各点一次 Stop | 本地 <500 ms 静音；文字 Agent 继续；仅此路径 cancel | 4 次 latency 和 Network |
| 互斥 | manual→live、live→manual、live→new prompt | 旧源先静音，任意时刻仅一套音频 | 录屏/Console |
| 生命周期 | live 中切会话、断线、pagehide/刷新 | 立即停止、无异常、重进后可再次播放 | Network/Console |
| 降级和 20 turn | Voice down 后发送；20 次混合操作 | 文本不受影响；无 reader/node/listener 持续增长 | UI/内存前后快照 |
