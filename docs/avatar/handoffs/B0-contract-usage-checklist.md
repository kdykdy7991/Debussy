# B0 契约使用清单

任务 ID：B0
作者：AI-B（经济模型/实现者）
日期：2026-08-08
依赖：A0（公共契约与 package exports 已冻结并确认）、A1、A2；A3 在 B0/B1 执行期间已并行交付（见下）
依据：

- `docs/avatar/PHASE-1-DEVELOPMENT-PLAN.md` 第 5 节（冻结契约）
- `docs/avatar/decisions/0001-public-contract-and-package-exports.md`（ADR-0001）
- `docs/avatar/decisions/0002-renderer-boundary.md`（ADR-0002）
- `packages/avatar/src/core/types.ts`、`src/core/errors.ts`、`src/core/controller.ts`、
  `src/core/state-machine.ts`、`src/core/runtime.ts`、`src/renderers/types.ts`
- `packages/avatar/src/testing/**`（A3 交付）

> **并发变更说明**：B0/B1 执行期间（2026-08-08），AI-A 并行完成了 A3：新增
> `@skdy/avatar/testing` 公共入口（package exports 第 6 个键）与 `src/testing/**` 的
> Fake 实现。本清单已同步更新；A0 冻结的其余字段与事件语义未变。

本清单供 AI-B 的 B1 及后续 B2～B8 使用，也供 AI-A Review 时对照。B0 只做清单，不修改任何 TypeScript 公共接口。

---

## 1. AI-B 可以使用的 AvatarState

```ts
export type AvatarState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";
```

- 来源：`packages/avatar/src/core/types.ts:5`，从 `@skdy/avatar` 与 `@skdy/avatar/core` 两个入口导出。
- 相邻可序列化类型（同文件，均可使用）：
  - `AvatarDisplayMode = "inline" | "floating"`
  - `AvatarPosition = "bottom-left" | "bottom-right"`
  - `AvatarSpeechEndReason = "completed" | "stopped" | "interrupted" | "failed"`
- 常量：`AVATAR_PROTOCOL_VERSION = 1`（`types.ts:3`），公共协议版本，第一阶段只能兼容扩展。
- 状态集合封闭：不允许 `tool-calling`、`rive-idle` 等任何非标准值；运行时 `setState()` 会以 `INVALID_CONFIG` 拒绝非法值（`public-contract.test-d.ts` 与 `controller.test.mjs` 均覆盖）。

## 2. AvatarController 的全部方法

`AvatarController`（`src/core/types.ts:65-76`）继承 `AvatarEventTarget`。全部成员：

```ts
interface AvatarController extends AvatarEventTarget {
  readonly state: AvatarState;
  initialize(config: AvatarConfig): Promise<void>;
  setState(state: AvatarState): void;
  setAudioLevel(level: number): void;
  speak(input: AvatarSpeechInput): Promise<void>;
  stopSpeaking(): void;
  interrupt(): void;
  show(): void;
  hide(): void;
  destroy(): void;
}
```

- `AvatarEventTarget`（`types.ts:52-63`）提供类型化 `addEventListener` / `removeEventListener`，监听六种标准事件。
- `speak()` 输入为 `{ audioUrl: string }`（`AvatarSpeechInput`），第一阶段只有 URL 音频；`text` / `visemes` / 流式描述是第二阶段预留，不得现在实现。
- 第一阶段**没有** `unlockAudio()`、`getState()`、`resize()` 等额外公共方法（ADR-0001）。宿主必须在用户手势回调里调用 `speak()` 以满足自动播放策略；需要显式解锁必须先提交契约变更请求。
- `CoreAvatarController`（`src/core/controller.ts:29`）是 A1 的实现类，**不在任何公共入口导出**；消费者不能通过 `@skdy/avatar/core` 导入它。AI-B 不得在消费者代码里深路径导入 `core/controller.js` 自行组装（测试文件内部深路径导入仅供 A1 测试使用）。A3 已交付 `@skdy/avatar/testing` 的 `createAvatarTestHarness()` 作为获取 `AvatarController` 实例的组合方式（见下）。

## 3. 六个标准 DOM 事件及其 detail

`AvatarEventMap`（`src/core/types.ts:33-47`），全部以带类型的 `CustomEvent` 派发，事件名和 detail 字段进入第一阶段后不得重命名。

| 事件名 | detail 类型 | 触发时机 |
| --- | --- | --- |
| `avatar-ready` | `{ characterId: string }` | `initialize()` 成功、资源和渲染器可用时，仅一次 |
| `avatar-state-change` | `{ previous: AvatarState; current: AvatarState }` | 标准状态实际发生变化（重复状态不触发） |
| `avatar-speech-start` | `{ audioUrl: string }` | 音频实际开始播放后 |
| `avatar-speech-end` | `{ audioUrl: string; reason: AvatarSpeechEndReason }` | 自然结束 / 停止 / 打断 / 失败；`reason` 固定为 `completed | stopped | interrupted | failed` |
| `avatar-error` | `{ code: AvatarError["code"]; message: string; cause?: unknown }` | 可观察错误发生；只保证 `code`、`message` 可序列化 |
| `avatar-interrupted` | `{ source: "host" | "user" }` | 调用 `interrupt()` 时 |

- 事件顺序必须与状态变化一致；`avatar-speech-end` 发出前嘴型值必须已归零（ADR-0001 行为语义）。
- 事件对象是 `CustomEvent`，detail 在 `event.detail`。
- 错误码使用 `AvatarError["code"]` 联合类型，见第 8 节禁止清单与 `src/core/errors.ts`。

## 4. AvatarConfig 和 CharacterManifest 的可用字段

```ts
export interface AvatarConfig {
  character: CharacterManifest | string; // 已解析 manifest 或 manifest URL（加载/校验属 A6）
  mode?: AvatarDisplayMode;              // "inline" | "floating"
  position?: AvatarPosition;             // "bottom-left" | "bottom-right"
  width?: number | string;
  height?: number | string;
  background?: string;
  autoplay?: boolean;
}

export interface CharacterManifest {
  id: string;
  version: string;
  renderer: "rive";                      // 第一阶段唯一值
  assetUrl: string;
  stateMachine: string;
  inputs: Partial<Record<AvatarState | "audioLevel", string>>;
}
```

- 来源：`src/core/types.ts:10-27`。
- 注意 `exactOptionalPropertyTypes` 开启：可选字段赋值不能写 `undefined`，除非该字段显式允许。
- `renderer` 联合目前只有 `"rive"`；`inputs` 是状态名 / `audioLevel` 到 Rive 输入名的映射，Rive 专有名称只存在于 manifest 和 renderer 内部，不进入公共方法参数。
- `AvatarConfig.character` 支持对象或字符串 URL 两种形式（对象已解析、URL 由 A6 加载校验）。

## 5. 各方法在初始化前、销毁后和重复调用时的行为

来源：`src/core/controller.ts`（A1 已实现并测试）。AI-B 的 Web Component 与 React 适配器必须保持一致语义。

### 初始化前（lifecycle `new`）

- `setState` / `setAudioLevel` / `speak` / `stopSpeaking` / `interrupt` / `show` / `hide` 一律同步抛出 `AvatarError`，`code = "NOT_INITIALIZED"`，不得静默失败。
- `initialize(config)` 可调用；`destroy()` 可调用（进入 `destroyed`）。
- `state` 读取返回状态机初始值 `"idle"`。

### 初始化进行中（lifecycle `initializing`）

- 重复 `initialize()` 返回**同一个 Promise**（同一结果），不会并行启动两次。

### 初始化成功后（lifecycle `ready`）

- 重复 `initialize()` 幂等，直接返回 `Promise.resolve()`，不再触发 `avatar-ready`。
- `setState(currentState)` 重复传当前状态：不调用 renderer、不触发 `avatar-state-change`。
- `setAudioLevel()` 将输入钳制到 `0..1`；非有限值（如 `NaN`）归零。
- 新 `speak()` 会中断仍在播放/等待的旧 `speak()`，第一阶段无播放队列。
- `stopSpeaking()` 是正常停止，结束 reason 为 `stopped`。
- `interrupt()` 表示用户或宿主打断，结束 reason 为 `interrupted`，并额外触发 `avatar-interrupted`。

### 初始化失败

- `initialize()` 失败后回到未初始化状态（`new`），允许宿主修复后重试；失败时派发 `avatar-error` 并 reject 该 Promise。

### 销毁后（lifecycle `destroyed`）

- 除 `destroy()` 本身外，其余控制命令（含 `initialize()`）一律同步抛出 `AvatarError`，`code = "ALREADY_DESTROYED"`。
- `destroy()` 幂等：第二次调用是 no-op，底层 `runtime.destroy()` 只执行一次；销毁会 abort 进行中的语音、把 `audioLevel` 归零并清空事件监听。
- `state` 读取仍可用（返回最后状态）。

## 6. Web Component 后续需要代理的属性、方法和事件

供 B2 参考（本任务不实现）。`<pi-avatar>` 表面来自计划第 5.4 节与 `AvatarController` 对齐：

- **属性**（只接受可序列化配置，`src/web-component` 实现）：`character`、`state`、`mode`、`position`、`width`、`height`；配置语义上还预留 `background`、`autoplay`（对应 `AvatarConfig` 字段）。复杂控制走元素方法，不放大属性面。
- **方法**（与 `AvatarController` 对齐）：`initialize`、`setState`、`setAudioLevel`、`speak`、`stopSpeaking`、`interrupt`、`show`、`hide`、`destroy`；属性 `state` 只读。
- **事件**（原样转发六种标准事件名与 detail）：`avatar-ready`、`avatar-state-change`、`avatar-speech-start`、`avatar-speech-end`、`avatar-error`、`avatar-interrupted`。
- 注册防御：使用 `customElements.get("pi-avatar")` 防止重复定义（ADR-0001 影响、风险登记项）。
- 多实例互不干扰：每实例独立 controller，不做模块级单例。
- **B2 测试通道**：A3 已交付 `@skdy/avatar/testing` 的 `createAvatarTestHarness({ container, renderer?, audio?, fallbackCharacter? })`
  → `{ controller, runtime, renderer, audio }`，可在无真实 Rive/音频时驱动五种状态与语音完成/失败
  （`FakeAudio.finishSpeech()` / `failSpeech()` / `rejectNextStart()`）。B2 组件测试应使用它，不要自行复制 Fake。

## 7. AI-B 禁止依赖或修改的内部接口

- `src/core/**`：`CoreAvatarController`、`AvatarStateMachine`、`isAvatarState`、`assertAvatarState`、`AvatarRuntimePort`、`AvatarSpeechSession`（实现不得改，消费者代码不得深路径导入组装）。
- `src/renderers/**`：`AvatarRenderer`、`AvatarRendererInitialization`、`AvatarViewport`、`AvatarRendererFactory`——内部接口，**不加入 package exports**（`renderer-boundary.test.mjs` 断言 `exports["./renderers"] === undefined`）。AI-B 只能通过 `@skdy/avatar/testing` 使用 A3 提供的 Fake，不得自行发明或复制一套 renderer 接口。
- `src/audio/**`：音频生命周期策略由 AI-A 决定，AI-B 不得实现或绕过。
- `src/testing/**`：A3 交付的 Fake 实现，**只使用、不得修改**；`@skdy/avatar/testing` 是公共入口，AI-B 可以 `import` 其中导出。
- 公共类型、事件名、错误码、`CharacterManifest` schema、package exports：不得新增、重命名或移除。
- Rive 输入名：不得进入 Web Component 属性或公共方法。
- 错误码只能使用 `src/core/errors.ts` 冻结联合：`NOT_INITIALIZED`、`ALREADY_DESTROYED`、`INVALID_CONFIG`、`INVALID_MANIFEST`、`CHARACTER_LOAD_FAILED`、`RENDERER_INITIALIZATION_FAILED`、`AUDIO_LOAD_FAILED`、`AUDIO_PLAYBACK_FAILED`、`AUDIO_AUTOPLAY_BLOCKED`、`UNSUPPORTED_BROWSER`、`INTERNAL_ERROR`。
- 公共 API 不允许 `any`；不得以临时类型断言、静默 catch 或跳过测试绕过契约问题（计划第 3.3 节）。
- 需要修改上述任何内容时，停止当前任务并提交契约变更请求。

## 8. 发现的契约疑问

**入口面变更记录（非 AI-B 发起）**：A3 并行交付时把 `@skdy/avatar/testing` 加入 package exports，
并同步更新 `package-contract.test.mjs` 为 6 个入口键。这是 AI-A 的契约变更，AI-B 只消费、未修改 exports。
除此之外，A0 冻结的入口、事件名、错误码与 manifest schema 无变化。

以下疑问**不阻塞 B1**（B1 只做构建），但其中 Q1、Q2 建议在 B2（Web Component 实现）之前由 AI-A 确认或澄清：

- **Q1（建议 B2 前确认）**：`avatar-interrupted` 的 detail 允许 `source: "user"`，但公共方法 `interrupt()` 无参数，A1 实现固定派发 `{ source: "host" }`（`controller.ts` 第 161 行）。Web Component 里用户主动点击打断时，元素只能转发 `controller.interrupt()`，无法表达 `source: "user"`。期望行为待 AI-A 定：保持 `host` 单一取值，还是扩展 `interrupt()` 签名。
- **Q2（建议 B2 前确认）**：`interrupt()` 在没有活动语音时仍会派发 `avatar-interrupted`（`controller.ts` 第 158-162 行）；`stopSpeaking()` 则是纯 no-op。这是否为有意的对外语义，Web Component 是否要原样镜像，请 AI-A 确认。
- **Q3（记录性）**：计划第 4 节模块结构列出了 `src/core/events.ts`，实际实现把 `AvatarEventMap` 等事件类型放在 `src/core/types.ts`；纯内部文件布局差异，不影响公共契约。
- **Q4（记录性）**：`avatar-error` 的 `cause` 仅在 type 上可选存在，A1 当前仅在该字段有值时才写入 detail；error 事件只保证 `code` 与 `message` 可序列化，`cause` 仅用于同页诊断（ADR-0001）。

除此之外，无其他契约变更请求。

### A4 对 Q1/Q2 的确认

- **Q1 已确认**：第一阶段不修改 `interrupt()` 公共签名。宿主或 Web Component
  公共方法调用 `controller.interrupt()` 时原样转发 `source: "host"`。`"user"` 为未来
  数字人内部交互控件保留；B2 不实现内部打断按钮，也不得自行合成该来源。
- **Q2 已确认**：无活动语音时调用 `interrupt()` 仍派发 `avatar-interrupted` 是有意
  语义。该事件表达宿主的中断意图，未来 Adapter 可据此取消尚未进入音频阶段的
  Agent/TTS 工作。B2 必须原样镜像；`stopSpeaking()` 在无语音时仍保持 no-op。
