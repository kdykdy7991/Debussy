# ADR-0001：Avatar 公共契约与包入口

状态：Accepted  
日期：2026-08-08  
决策人：AI-A（A0）  
确认状态：产品/技术验收人已于 2026-08-08 确认

## 背景

数字人前端需要同时服务原生 HTML、React、Vue 和未来的 iframe/Agent Adapter。第一阶段需要冻结一个不依赖 Pi、Agent runtime、Rive 专有字段和具体 UI 框架的公共接口，使 Core 与嵌入层能够并行开发。

## 决策

1. npm 包名为 `@skdy/avatar`，第一阶段采用单包多入口。
2. 根入口和 `./core` 无运行时框架依赖，也不自动注册 Custom Element。
3. `./web-component` 是唯一允许注册 `<pi-avatar>` 的入口，因此单独标记为有副作用。
4. `./react` 是可选入口，React 只作为 optional peer dependency，不进入基础产物。
5. 公共控制接口只表达数字人状态、音频和生命周期，不包含 Pi/Agent 事件。
6. Rive 输入名只存在于 Character Manifest 和 renderer 内部，不出现在控制器方法中。
7. 公共事件采用带类型的 DOM `CustomEvent`，Core 控制器和 Web Component 使用相同事件名与 detail。
8. 公共协议版本从常量 `AVATAR_PROTOCOL_VERSION = 1` 开始。第一阶段只能兼容扩展，不能重命名或移除字段。

## 行为语义

- `initialize()` 成功后发出一次 `avatar-ready`；失败时拒绝 Promise 并发出 `avatar-error`。
- 并发或成功后的重复 `initialize()` 幂等；初始化失败后允许重试。
- 初始化前的控制命令抛出 `NOT_INITIALIZED`。
- 重复设置当前状态不调用 renderer，也不发出状态变化事件。
- `setAudioLevel()` 的实现必须把输入钳制在 `0..1`。
- 新 `speak()` 中断仍在播放的旧音频；第一阶段不提供播放队列。
- 音频实际开始播放后才进入 `speaking` 并发出 `avatar-speech-start`。
- 自然结束后发出 reason `completed` 并回到 `idle`。
- `stopSpeaking()` 发出 reason `stopped`；`interrupt()` 发出 reason `interrupted` 和 `avatar-interrupted`。
- 播放失败发出 reason `failed` 和 `avatar-error`。
- `destroy()` 幂等。销毁后的控制命令抛出 `ALREADY_DESTROYED`，重复 `destroy()` 除外。
- 事件顺序必须与状态变化一致；结束事件发出前，嘴型值必须归零。

## 错误约定

所有公共错误使用 `AvatarError`，其 `code` 是稳定、可机器判断的字符串联合类型。错误事件只保证 `code` 与 `message` 可序列化；`cause` 仅用于同页诊断，未来通过 iframe 传输时必须清洗。

浏览器自动播放被阻止时使用 `AUDIO_AUTOPLAY_BLOCKED`，不得伪装成播放成功。第一阶段不增加 `unlockAudio()` 公共方法；宿主应在用户手势回调中调用 `speak()`。若实现证明需要显式解锁，必须提交契约变更请求。

## 入口布局

```text
@skdy/avatar                → dist/index.js
@skdy/avatar/core           → dist/core/index.js
@skdy/avatar/web-component  → dist/web-component/index.js
@skdy/avatar/react          → dist/react/index.js
@skdy/avatar/package.json   → package.json
```

未来 iframe transport、Agent Adapter、Vue wrapper 或 renderer 扩展不会自动加入根入口，应通过独立子路径或独立包提案处理。

## 影响

- AI-A 和 AI-B 可以通过同一份类型契约和 Fake 实现并行开发。
- React/Vue/Agent 不会成为 Core 的直接依赖。
- 使用 DOM EventTarget 让目标限定为 Web 环境，符合本项目“Web 数字人”定位。
- `./web-component` 的自动注册行为必须处理重复加载；AI-B 在 B2 中使用 `customElements.get()` 防止重复定义。
