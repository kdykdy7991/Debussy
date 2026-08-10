# B2 交接：`<pi-avatar>` 与 Shadow DOM 容器

状态：Approved by AI-A（B2 Review 4 项复修通过；B3 已于 2026-08-10 完成并通过 Review）
作者：AI-B（经济模型/实现者）
日期：2026-08-10（初审 2026-08-09）
依赖：B0（契约使用清单）、A3（`@skdy/avatar/testing` Fake 夹具）、A4（构建审定 + Q1/Q2 答复）

## 任务 ID：B2

```text
实现 <pi-avatar> 和 Shadow DOM 容器
完成标准（计划 §6.2）：属性映射、方法代理、连接/断开生命周期有测试
```

## 1. 只允许修改的路径（计划 §3.2）

| 文件 | 说明 |
| --- | --- |
| `packages/avatar/src/web-component/index.ts` | `@skdy/avatar/web-component` 公共入口：注册元素 + 导出工厂注入点 |
| `packages/avatar/src/web-component/pi-avatar.ts` | `<pi-avatar>` 元素实现（首轮修复容器样式 bug；本轮按 B2 Review 修复 4 项） |
| `packages/avatar/test/pi-avatar.test.mjs` | 组件测试（首轮新增 Shadow DOM 容器样式用例；本轮新增 3 项回归测试） |
| `packages/avatar/test/pi-avatar-registration.test.mjs` | 重复定义防御测试 |
| `docs/avatar/handoffs/B2-handoff.md` | 本交接单 |
| `packages/avatar/README.md` | 同步阶段状态说明（消费者文档，AI-B 可改） |

未修改：Core、Renderer、Audio、Testing、Vite entries、package exports、`package.json` 冻结字段。

## 2. 输入契约

- **类型/方法**（`@skdy/avatar` / `@skdy/avatar/core`）：
  `AvatarController` 全部方法、`AvatarConfig`、`AvatarState`、`AvatarDisplayMode`、`AvatarPosition`、`AvatarSpeechInput`、`AvatarEventMap`、`AvatarError`（仅 `NOT_INITIALIZED` / `INVALID_CONFIG` / `INTERNAL_ERROR` 三个错误码）。
- **事件**：六个标准事件原样转发，detail 不重命名。
- **Fake**（`@skdy/avatar/testing`）：`createAvatarTestHarness({ container, fallbackCharacter? })` → `{ controller, runtime, renderer, audio }`；`FakeAudio.finishSpeech()` / `failSpeech()` 控制语音结束。组件测试全部经 `setControllerFactory()` 注入 harness 工厂，未深路径导入 `core/controller.js`。
- **A4 Q1/Q2 答复**：`interrupt()` 固定转发 `source: "host"`；无活动语音时仍派发 `avatar-interrupted`，B2 原样镜像。不实现内部打断按钮，不合成 `source:"user"`。

## 3. 需要实现的行为清单（已全部可核验）

1. **注册防御**：加载 `@skdy/avatar/web-component` 时经 `customElements.get("pi-avatar")` 防重复定义；预定义存在时不覆盖（ADR-0001 风险项）。
2. **Shadow DOM 容器**：`attachShadow({ mode: "open" })`；惰性创建 `div[data-avatar-stage]`，作为 renderer 初始化容器；把 `width`/`height`/`background` 与 `mode`/`position` 落到容器（本次修复 `#stage` 未赋值导致样式未生效的 bug）。
3. **属性映射**：`character`、`state`、`mode`、`position`、`width`、`height`、`background`、`autoplay` 进 `observedAttributes`；纯数字尺寸归一化为 CSS 像素（`320` → `320px`）；`character` 在初始化进行中或已初始化后变化时销毁重建控制器，最终以最新 `character` 为准（B2 Review #1）。
4. **方法代理**：`initialize` / `setState` / `setAudioLevel` / `speak` / `stopSpeaking` / `interrupt` / `show` / `hide` / `destroy` 与 `AvatarController` 对齐；`state` 只读 getter。
5. **事件转发**：六个标准事件以同名 `CustomEvent` 重新派发在元素上；`avatar-state-change` 同步回写 `state` 属性（重复写当前状态不触发额外 renderer 调用）。
6. **连接/断开生命周期**：`connectedCallback` 创建控制器并按需自动初始化；`disconnectedCallback` 销毁控制器、解绑全部监听、清空初始化标记与待定状态；重连创建全新实例。
7. **自动初始化**：存在 `character` 即连接自动初始化；`autoplay` 不参与初始化判定，仅作为 `AvatarConfig.autoplay` 传给 Controller（B2 Review #3）。
8. **错误语义与初始化期行为**：无工厂/无控制器时 `setState` 等方法抛 `NOT_INITIALIZED`；非法 `state` 属性与缺工厂分别派发 `avatar-error`（`INVALID_CONFIG` / `INTERNAL_ERROR`）；初始化进行中的 `setState`（方法或 `state` 属性）不抛错，保存最新状态并在初始化成功后应用，过期控制器不参与元素驱动（B2 Review #2）。

## 4. 禁止修改核对（未触碰）

- `src/core/**`、`src/renderers/**`、`src/audio/**`、`src/testing/**` 实现：未改。
- 公共类型、事件名、错误码、`CharacterManifest` schema、package exports：未改。
- Vite entries（`vite.config.ts`）与 `package.json` 冻结字段：未改。
- 未引入 `any` / 临时类型断言 / 静默 catch 绕过契约问题。

## 5. 验收用例映射（计划 §11，B2 组件层；E2E 归 B7）

| AC | B2 覆盖 |
| --- | --- |
| AC-01 加载入口注册元素并发出 `avatar-ready` | 「registers <pi-avatar>」+「auto-initializes on connect and forwards avatar-ready」 |
| AC-03 连续切换状态 | 「state attribute reflects controller state」/「invalid state attribute surfaces avatar-error」 |
| AC-05 播放中 `interrupt()` | 「interrupt mirrors controller semantics (Q1/Q2)」 |
| AC-08 从 DOM 移除再插入 | 「disconnect destroys the controller; reconnect creates a fresh one」 |

CSS 隔离（AC-02）、真实音频/资源（AC-04/07）、多实例（AC-09）留待 B3/B5/B7 验证。

## 6. 验证命令与结果（在 `packages/avatar` 内执行）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（exit 0，含全部 `.test-d.ts`） |
| `npm test` | 通过：37/37（core 10 + B2 组件 18 + A3 testing 4 + A0 契约 5） |
| `npm run test:build` | 通过：5/5（含跨入口 `AvatarError` 类身份、React 不入基础产物、媒体不内联） |

B2 组件用例：18 项，覆盖注册防御、属性映射、方法代理、speak/打断事件、状态回写、错误语义、断开重建、autoplay、显式 manifest，以及本轮新增的 3 项 Review 回归用例（character 中途变更 / initialize 期间 setState / 移除尺寸背景清样式）。

## 7. 本次会话改动明细

**首轮（初审前）**

- **修复 bug**：`pi-avatar.ts` 的 `#stage` 字段此前从未被赋值，导致 `#applyLayoutAttributes()` 永远提前返回，Shadow DOM 容器宽度/高度/背景与 `data-avatar-mode`/`data-avatar-position` 从未生效。`#createController()` 现赋值 `this.#stage`。
- **新增测试**：`test/pi-avatar.test.mjs` 增加「Shadow DOM stage container is styled from serializable attributes」，断言容器 `data-avatar-stage`、mode/position data 属性与 `width`/`height`/`background` 样式。
- **README**：`packages/avatar/README.md` 阶段状态同步为「A0～A4、B0～B2 已完成」。

**本轮（按 B2 Review 复修，仅改 `pi-avatar.ts` + 测试）**

- **Review #1（character 中途变更）**：初始化进行中 `character` 属性变化时，`attributeChangedCallback` 立即销毁旧控制器并重建（原来仅 `#initialized` 完成后才重建）；`initialize()` 完成后以 `#controller !== controller` 守卫，丢弃已被替换的旧控制器结果，最新角色最终胜出。新增回归测试「character change during initialize loads the latest character (B2 #1)」。
- **Review #2（initialize 期间 setState）**：`#initialized` 布尔改为 `#initializePromise`；`setState` 与 `state` 属性在初始化进行中不再抛 `NOT_INITIALIZED`，存入 `#pendingState`，初始化成功后应用（控制器已达的同值状态不覆盖）。新增回归测试「setState during initialize does not throw and applies after init (B2 #2)」。
- **Review #3（autoplay）**：`#shouldAutoInitialize()` 仅检查 `character` 存在；`autoplay` 只经 `#configFromAttributes()` 作为 `AvatarConfig.autoplay` 传给 Controller。原「explicit initialize is honored when autoplay is disabled」用例改写为「autoplay=false does not block initialization and flows into the config」，断言自动初始化发生且 `config.autoplay === false`。
- **Review #4（移除样式属性清内联样式）**：`#applyLayoutAttributes()` 在 `width`/`height`/`background` 缺失时写入空字符串清除内联样式，防止旧值残留。新增回归测试「removing width/height/background clears the stage inline styles (B2 #4)」。

## 8. 遗留问题 / 移交说明

- 真实 controller 组合层（renderer + audio + manifest 加载）不属于 B2；生产环境 `<pi-avatar>` 需要宿主或后续任务经 `setControllerFactory()` 注册工厂。`src/web-component/index.ts` 的 `setControllerFactory` / `getControllerFactory` 即此注入缝。
- B3 已在本交接之后完成，容器的 `data-avatar-mode` / `data-avatar-position` 已被布局实现使用。
- B2 无剩余阻断项；后续任务以 `docs/avatar/tasks/README.md` 的状态为准。

## 9. 契约变更请求

**无。** 未发现契约无法表达 B2 需求的情形。
