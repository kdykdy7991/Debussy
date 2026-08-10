# Web 数字人第一阶段并行开发计划

状态：Active  
适用范围：`packages/avatar` 及数字人独立演示应用  
参与角色：AI-A（强模型/技术负责人）、AI-B（经济模型/实现者）、产品/技术验收人  
阶段目标：交付一个与业务框架和 Agent runtime 解耦、能嵌入任意 Web 项目的数字人前端 MVP。

执行状态（2026-08-10）：`A0～A6、A6-PREVIEW、B0～B4 已完成`。真实 Rive 预览已可见，等待用户视觉确认；B5 并行收口，语音 A7/A8 延后。产品顺序见 [优先级路线](./PRIORITY-ROADMAP.md)，可派发任务见 [tasks/README.md](./tasks/README.md)。

当前产品优先级：**真实数字人视觉预览 → 跨项目嵌入 → 独立 Agent Adapter 阶段 → 语音与嘴型 → 完整验收**。Agent 通信仍不进入本阶段 Core，实现前另行冻结后端 transport/message 契约。

## 1. 阶段目标

第一阶段必须形成可独立演示、可被其他项目接入、后续可通过 Adapter 对接 Agent 的前端产品能力。

交付结果必须满足：

1. 普通 HTML 页面通过 `<script type="module">` 和 `<pi-avatar>` 完成接入。
2. React 和 Vue 示例不需要复制数字人内部逻辑。
3. 支持 `inline` 和 `floating` 两种展示模式。
4. 支持 `idle`、`listening`、`thinking`、`speaking`、`error` 五种标准状态。
5. 支持播放 URL 音频，并使用 Web Audio API 的音量数据驱动基础嘴型。
6. 支持停止和打断播放，并发出标准生命周期事件。
7. 组件样式不受宿主页面 CSS 影响，也不污染宿主页面。
8. 产物可以作为静态 ESM 文件部署到 CDN。
9. 核心层不依赖 Pi、Agent session、React 或 Vue。

第一阶段不包含 Agent 协议接入、TTS 服务调用、语音识别、精确 viseme、3D 模型、运营后台和鉴权系统。

## 2. 技术基线

| 领域 | 选型 | 约束 |
| --- | --- | --- |
| 语言 | TypeScript strict mode | 公共 API 不允许使用 `any` |
| 构建 | Vite Library Mode | 输出 ESM；角色资源不得内联进 SDK |
| 动画 | Rive Canvas/WASM | Rive 专有名称不得暴露为公共 API |
| 通用组件 | Custom Elements + Shadow DOM | 不依赖 React/Vue runtime |
| 音频 | Web Audio API | 同一页面共享或显式释放 AudioContext |
| 单元测试 | Vitest | 核心状态机和命令行为必须覆盖 |
| 浏览器验收 | Playwright | 覆盖 Chromium，后续扩展 WebKit/Firefox |
| 示例 | 原生 HTML、React、Vue | 三者使用同一构建产物 |

## 3. AI 角色定义与执行规则

本文不是供两个 AI 自行认领任务的任务池。启动任务时必须明确告诉 AI 它是 `AI-A` 还是 `AI-B`；AI 只能执行归属于自己且满足启动条件的任务。

### 3.1 AI-A：强模型/技术负责人

AI-A 负责架构、高风险底层实现、公共契约和最终技术验收。

AI-A 的职责：

- 决定并维护公共类型、控制器行为、事件语义和内部抽象。
- 实现状态机、Rive、Web Audio、异步竞态和资源生命周期。
- 为 AI-B 提供稳定的 FakeRenderer、FakeAudio 和契约测试。
- Review AI-B 对公共 API、生命周期和构建边界的使用。
- 处理两个模块之间的集成缺陷和难以复现的浏览器问题。

AI-A 可以修改：

- `packages/avatar/src/core/**`
- `packages/avatar/src/renderers/**`
- `packages/avatar/src/audio/**`
- `packages/avatar/src/testing/**`
- 公共入口、公共类型、package exports 和契约测试
- 经 Review 需要修复的其他 Avatar 文件

AI-A 不应把 Pi、Agent session、TTS Provider 或业务协议引入 Core。

### 3.2 AI-B：经济模型/实现者

AI-B 负责在冻结契约下完成边界清晰、可通过测试直接验收的嵌入层工作。

AI-B 的职责：

- 实现 Web Component、Shadow DOM、布局和方法代理。
- 实现 Embed SDK 和 React 薄适配器。
- 编写 Vanilla、React、Vue 示例和消费者文档。
- 根据既定验收场景实现组件测试和 Playwright 测试。

AI-B 可以修改：

- `packages/avatar/src/web-component/**`
- `packages/avatar/src/embed/**`
- `packages/avatar/src/react/**`
- `packages/avatar/examples/**`
- `packages/avatar/test/component/**`
- `packages/avatar/test/e2e/**`
- 面向消费者的接入文档
- 仅在 B1 中可修改 `packages/avatar/vite.config.ts`、相关 `tsconfig` 和 `package.json` 的 scripts/devDependencies；B5 另有一次性预授权，只能补充 React 测试/类型 devDependencies，不得改变 optional peer 语义。不得修改 A0 已冻结的 name、version、exports、sideEffects、peerDependencies 和 files。

AI-B 禁止自行修改：

- `core`、`renderers`、`audio` 和 `testing` 的实现。
- 公共类型、事件名、错误码和 `AvatarController` 接口；ADR-0005 已批准的 B4 Embed 类型及根入口导出除外，必须逐字按任务单实现。
- Character Manifest schema 和 package exports。
- Rive 输入名、音频生命周期策略和 Agent 预留协议。

如果 AI-B 认为必须修改上述内容，应停止对应任务，提交“契约变更请求”，写明当前行为、期望行为、原因、兼容影响和最小复现，由 AI-A 决策。AI-B 可以继续执行不受影响的其他任务。

### 3.3 共同规则

两个 AI 都必须遵守：

1. 开始前阅读本文全部内容和 `docs/ARCHITECTURE-BASELINE.md`。
2. 检查工作区现有改动，不覆盖不属于自己任务的修改。
3. 一次只执行一个任务 ID；完成后输出改动文件、验证命令、结果和遗留问题。
4. 不扩大任务范围，不顺手重构另一方负责的模块。
5. 不以临时类型断言、`any`、静默 catch 或跳过测试绕过契约问题。
6. 依赖未就绪时使用约定的 Fake，不自行复制或发明另一套接口。
7. 视觉行为变化必须提供截图或录屏；底层行为变化必须提供自动化测试。

## 4. 模块结构与所有权

第一阶段采用单包多入口，减少仓库和发布配置成本，同时保留未来拆包边界。

```text
packages/avatar/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── core/                    # AI-A 主责
│   │   ├── controller.ts
│   │   ├── state-machine.ts
│   │   ├── types.ts
│   │   └── events.ts
│   ├── renderers/rive/          # AI-A 主责
│   ├── audio/                   # AI-A 主责
│   ├── testing/                 # AI-A 提供 Fake 和测试工具
│   ├── web-component/           # AI-B 主责
│   ├── embed/                   # AI-B 主责
│   ├── react/                   # AI-B 主责
│   └── index.ts
├── assets/
│   └── characters/demo/         # AI-A 维护动画映射，AI-B 维护加载示例
├── examples/                    # AI-B 主责
│   ├── vanilla/
│   ├── react/
│   └── vue/
└── test/
    ├── unit/                    # 各模块作者负责
    ├── component/               # AI-B 主责
    └── e2e/                     # AI-B 实现，AI-A 设计高风险场景
```

所有权表示主要评审责任，不表示其他人不能修改。跨所有权修改必须由对应负责人 Review。

## 5. 首日冻结的公共契约

并行开发成立的前提是先冻结最小公共契约。两位开发者在编码前共同评审以下定义；评审后只能以兼容方式扩展。

### 5.1 状态和配置

```ts
export type AvatarState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export type AvatarDisplayMode = "inline" | "floating";
export type AvatarPosition = "bottom-left" | "bottom-right";

export interface AvatarConfig {
  character: CharacterManifest | string;
  mode?: AvatarDisplayMode;
  position?: AvatarPosition;
  width?: number | string;
  height?: number | string;
  background?: string;
  autoplay?: boolean;
}

export interface CharacterManifest {
  id: string;
  version: string;
  renderer: "rive";
  assetUrl: string;
  stateMachine: string;
  inputs: Partial<Record<AvatarState | "audioLevel", string>>;
}
```

### 5.2 控制器

```ts
export interface AvatarController {
  readonly state: AvatarState;
  initialize(config: AvatarConfig): Promise<void>;
  setState(state: AvatarState): void;
  setAudioLevel(level: number): void;
  speak(input: { audioUrl: string }): Promise<void>;
  stopSpeaking(): void;
  interrupt(): void;
  show(): void;
  hide(): void;
  destroy(): void;
}
```

行为约定：

- 首次 `initialize()` 进行中时，重复调用返回同一结果；成功后的重复调用幂等。
- `initialize()` 失败后回到未初始化状态，允许宿主修复问题后重试。
- `setAudioLevel()` 将输入钳制在 `0..1`。
- 将当前状态重复传给 `setState()` 不触发 renderer 调用和状态事件。
- `speak()` 开始有效播放后进入 `speaking`，自然结束后回到 `idle`。
- 新的 `speak()` 默认中断旧音频，第一阶段不实现播放队列。
- `stopSpeaking()` 是正常停止；`interrupt()` 表示由用户或宿主打断。
- `destroy()` 必须幂等，并释放动画帧、事件监听和音频节点。
- 初始化前调用控制命令必须返回明确错误，不能静默失败。

### 5.3 DOM 事件

| 事件名 | detail | 触发时机 |
| --- | --- | --- |
| `avatar-ready` | `{ characterId }` | 资源和渲染器可用 |
| `avatar-state-change` | `{ previous, current }` | 标准状态发生变化 |
| `avatar-speech-start` | `{ audioUrl }` | 音频实际开始播放 |
| `avatar-speech-end` | `{ audioUrl, reason }` | 自然结束、停止或打断 |
| `avatar-error` | `{ code, message, cause? }` | 可观察错误发生 |
| `avatar-interrupted` | `{ source }` | 调用 `interrupt()` |

`reason` 固定为 `completed | stopped | interrupted | failed`。事件名和字段进入第一阶段后不得重命名。

### 5.4 Web Component 表面

```html
<pi-avatar
  character="/characters/demo/manifest.json"
  state="idle"
  mode="floating"
  position="bottom-right"
  width="320"
  height="480"
></pi-avatar>
```

属性只接受可序列化配置；复杂控制通过元素方法完成。元素公开的方法与 `AvatarController` 对齐。

## 6. 两个 AI 的任务清单

分工依据是技术难度和失败风险，而不是代码行数。AI-A 承担渲染、时序、资源生命周期和接口决策；AI-B 在已冻结的接口下承担嵌入层和示例实现。

### 6.1 AI-A 任务：渲染内核、状态机与音频

主要风险：Rive 生命周期、异步竞态、Web Audio 自动播放策略、资源回收、嘴型采样稳定性。

| ID | 任务 | 依赖 | 完成标准 |
| --- | --- | --- | --- |
| A0 | 冻结公共契约和 package exports | 无 | 第 5 节定稿；输出类型文件、入口草案和决策记录 |
| A1 | 实现无框架 `AvatarController` 和状态机 | A0 | 非法状态、重复命令、销毁后调用均有测试 |
| A2 | 定义 `AvatarRenderer` 内部接口 | A0 | Core 不引用 Rive 类型，可注入 FakeRenderer |
| A3 | 交付 FakeRenderer/FakeAudio 与契约测试 | A1、A2 | AI-B 无需真实 Rive/音频即可开发；附使用示例 |
| A4 | 审定构建公共入口 | A0、B1 草案 | core/component/react 入口清晰，React 不进入基础产物 |
| A5 | 实现 Rive renderer | A2 | 加载、状态切换、resize、销毁均可验证 |
| A6 | [实现 Character Manifest 加载和校验](./tasks/A6-character-manifest.md) | A5 | URL/对象两种输入；错误转换为标准错误事件 |
| A6-PREVIEW | [真实数字人视觉预览](./tasks/A6-PREVIEW-visual-runtime.md) | A5、A6 | 真实 Rive 角色可见，五状态、resize、销毁和最小预览页可用；不依赖语音 |
| A7 | [实现音频播放器](./tasks/A7-audio-player.md) | A1 | 支持 URL、结束、停止、打断、重复播放与 CORS 错误 |
| A8 | [实现 `AnalyserNode` 音量采样](./tasks/A8-audio-analyser.md) | A7 | 输出归一化 `0..1`，停止后归零且无 RAF 泄漏 |
| A9 | [语音与视觉 Runtime 最终组合](./tasks/A9-demo-character-integration.md) | A6-PREVIEW、A7、A8 | 复用可见角色链路，补齐真实 speech、audioLevel 和资源生命周期 |
| A10 | [设计高风险 E2E 场景](./tasks/A10-e2e-risk-scenarios.md) | A9 | 输出竞态、重复挂载、销毁和错误路径的可执行场景 |
| A11 | [完成最终技术 Review](./tasks/A11-final-technical-review.md) | A10、B7、B8 | DoD 全部满足，公共 API 和资源生命周期无阻断问题 |

AI-A 每项任务的固定交付格式：

```text
任务 ID：A<n>
契约决策：新增/无变更；如新增则列出 ADR 或文档位置
修改文件：逐项列出
新增测试：逐项列出行为
验证命令：逐项列出
验证结果：通过/失败及原因
交给 AI-B 的可用入口：导入路径、Fake 用法、已知限制
```

### 6.2 AI-B 任务：Web Component、嵌入 SDK 与兼容验收

主要风险：Shadow DOM 隔离、Custom Element 生命周期、重复挂载、构建产物副作用、跨技术栈接入一致性。

| ID | 任务 | 依赖 | 完成标准 |
| --- | --- | --- | --- |
| B0 | 阅读冻结契约并建立契约使用清单 | A0 | 输出 `docs/avatar/handoffs/B0-contract-usage-checklist.md`；列出允许调用的方法/事件，不提出未确认的新 API |
| B1 | 在现有 Avatar 包上补充 Vite library build 草案 | A0、B0 | 不重建 A0/A1/A2 产物；ESM build 成功；不得改动已冻结的 package exports |
| B2 | 实现 `<pi-avatar>` 和 Shadow DOM 容器 | B0、A3 | 属性映射、方法代理、连接/断开生命周期有测试 |
| B3 | 按 [B3 任务单](./tasks/B3-inline-floating-layout.md) 实现 inline/floating 布局 | B2 | 左右定位、尺寸、移动端和 z-index 配置有效 |
| B4 | [实现 `createAvatar()` Embed SDK](./tasks/B4-embed-sdk.md) | B3 | 可挂载、获取 controller、销毁并重复创建 |
| B5 | [实现 React 薄适配器](./tasks/B5-react-adapter.md) | B4 | props 变化正确映射；卸载时销毁；不复制 Core 状态 |
| B6 | [建立 Vanilla/React/Vue 示例](./tasks/B6-framework-examples.md) | B3、B4、B5、A6-PREVIEW | 三个示例先完成真实视觉，A9 后补齐语音操作 |
| B7 | [建立 Playwright 嵌入验收](./tasks/B7-playwright-acceptance.md) | B6、A9、A10 | CSS 隔离、状态切换、播放/打断、重复挂载通过 |
| B8 | [编写消费者接入文档](./tasks/B8-consumer-docs.md) | B6、A9 | 15 分钟内可完成 Vanilla 接入，包含错误处理说明 |

AI-B 的任务执行模板：

```text
任务 ID：B<n>
只允许修改：从第 3.2 节选择并列出具体路径
输入契约：列出使用的类型、方法、事件和 Fake
需要实现：把任务拆成可核验的行为列表
禁止修改：core/renderers/audio/testing、公共 API、事件名、错误码
验收用例：引用 AC 编号
验证命令：typecheck、对应 test、必要时 build/e2e
完成报告：修改文件、测试结果、截图/录屏、遗留问题
```

AI-B 在以下情况必须停止当前任务并提交契约变更请求：

- 现有接口无法表达需求。
- Fake 与公共类型或实际行为不一致。
- 需要决定重复初始化、并发播放、断开重连或销毁语义。
- 需要新增/修改事件、错误码、manifest 字段或 package exports。
- 测试暴露 Core、Rive、音频或资源释放问题。

契约变更请求格式：

```text
阻塞任务：B<n>
当前契约：引用文件和符号
最小复现：步骤或测试
期望行为：一句话描述
建议变更：可选，不直接实施
兼容影响：现有消费者是否受影响
可继续任务：列出不受阻塞影响的 B 任务
```

## 7. 并行执行与依赖关系

```text
AI-A：契约冻结（A0）→ AI-B：契约使用清单（B0）
             │
       ┌─────┴─────┐
       │           │
AI-A：Core + Fake    AI-B：构建骨架
       │           │
   A3 测试夹具 ──→ B2 Web Component
       │           │
AI-A：Rive + Audio   AI-B：SDK + 布局 + 示例
       │           │
       └─────┬─────┘
             │
       联调、E2E、验收
```

减少互相等待的规则：

1. AI-A 在真实 Rive renderer 完成前先交付 FakeRenderer 和 FakeAudio。
2. AI-B 使用 Fake 开发 Web Component、SDK 和示例，不等待动画资源。
3. AI-B 先提供构建和 playground 入口，AI-A 使用该入口调试真实 renderer。
4. 公共类型由一人修改时，另一人必须 Review；禁止在各自分支复制类型。
5. Rive 输入名只存在于 manifest 和 renderer 内，不进入 Web Component 属性。

## 8. 可直接派发的执行批次

负责人应按以下批次派发，不要一次把整个阶段交给单个 AI。标记为并行的任务可以同时执行。

| 批次 | AI-A | AI-B | 进入下一批条件 |
| --- | --- | --- | --- |
| P0 | A0：契约和入口设计 | 等待；可阅读文档 | A0 通过验收人 Review |
| P1（并行） | A1、A2、A3 | B0、B1 | Fake 可用；构建草案可运行 |
| P2a（视觉优先） | A6、A6-PREVIEW | B4 | 用户可看到真实角色；Embed SDK 可挂载 |
| P2b（嵌入） | 视觉问题 Review | B5、B6 | Vanilla/React/Vue 都能展示真实角色 |
| P3（独立阶段） | 与 Agent runtime Owner 冻结 Adapter 契约 | 前端 Agent Adapter（另立任务） | 状态/中断通信可用，不侵入 Avatar Core |
| P4（语音最后） | A7、A8、A9 | 更新 B6 最终语音示例 | 音频、嘴型、错误和销毁链通过 |
| P5a（并行） | A10：设计高风险场景 | B7、B8 | 完整 E2E 与消费者文档完成 |
| P5b | A11：最终 Review | 等待 | DoD 全部满足 |

注意：P2 和 P3 中的“并行”表示两条所有权线可以同时工作，不表示同一 AI 可以跳过依赖任务。

## 9. AI 启动提示词模板

### 9.1 派发给 AI-A

```text
你是 Web 数字人第一阶段的 AI-A（强模型/技术负责人）。
完整阅读 docs/avatar/PHASE-1-DEVELOPMENT-PLAN.md 和
docs/ARCHITECTURE-BASELINE.md，然后只执行任务 <A任务ID>。

你负责公共契约、高风险底层实现和技术验收。严格遵守文档中的目录所有权、
启动依赖、完成标准和固定交付格式。先检查工作区和前置任务产物，不覆盖其他
任务的改动。完成实现、测试与验证；如发现契约需要变化，先更新契约和测试并
在完成报告中说明兼容影响。不要实现 Agent runtime、TTS Provider 或业务协议。
```

### 9.2 派发给 AI-B

```text
你是 Web 数字人第一阶段的 AI-B（经济模型/实现者）。
完整阅读 docs/avatar/PHASE-1-DEVELOPMENT-PLAN.md 和
docs/ARCHITECTURE-BASELINE.md，然后只执行任务 <B任务ID>。

你只能在冻结契约下实现嵌入层，严格遵守文档中的允许修改目录、禁止修改项、
启动依赖、完成标准和任务执行模板。先检查工作区与前置任务产物，使用 AI-A
提供的 Fake，不复制或发明 Core 接口。若需要修改公共 API、事件、错误码、
manifest、package exports 或底层生命周期，停止当前任务并按文档提交契约变更
请求；可以继续不受影响的任务。完成实现、测试、验证和固定格式报告。
```

## 10. 里程碑与退出条件

计划采用里程碑，不绑定具体人日；团队可根据人员经验再填排期。

### M0：契约冻结

- 公共类型、控制器行为、事件表和错误语义评审通过。
- 建立包骨架、测试命令和 CI 基础命令。
- 为第一阶段明确浏览器最低版本和资源托管域名策略。

退出条件：AI-A 完成 A0，AI-B 完成 B0，验收人共同批准本文第 5 节。

### M1：两条链路独立可运行

- AI-A：Fake host 中可以切换五种状态并完成音频播放/打断。
- AI-B：使用 FakeRenderer 的 `<pi-avatar>` 可在 Vanilla 页面完成嵌入。
- 单元测试能够在无真实浏览器音频设备的环境运行。

退出条件：Core API 与 Custom Element API 的契约测试通过。

### M2：真实能力集成

- 真实 Rive 角色接入。
- inline/floating 布局完成。
- 音频音量能够驱动嘴型。
- React/Vue 示例完成。

退出条件：三个示例都使用正式 build 产物通过手工冒烟。

### M3：发布候选版

- Playwright 验收通过。
- README、API、部署和常见问题文档完成。
- CDN 部署产物经干净 HTML 页面验证。
- 已知限制形成清单。

退出条件：第一阶段验收清单全部通过，不存在阻断级问题。

## 11. 验收用例

| 编号 | 场景 | 预期结果 |
| --- | --- | --- |
| AC-01 | Vanilla 页面只加载 ESM script 和 `<pi-avatar>` | 数字人显示并发出 `avatar-ready` |
| AC-02 | 宿主页面定义激进的 `canvas`, `button`, `div` 样式 | Shadow DOM 内显示不受影响 |
| AC-03 | 连续切换五种状态 | 最终状态正确，无重复实例或控制台错误 |
| AC-04 | 播放可访问的音频 URL | 进入 speaking，嘴型变化，结束回 idle |
| AC-05 | 播放中调用 `interrupt()` | 立即停止，嘴型归零，事件 reason 为 interrupted |
| AC-06 | 快速连续调用两次 `speak()` | 第一段被中断，只播放第二段，无竞态回写 |
| AC-07 | 音频或角色 URL 404/CORS 失败 | 发出标准 error，不出现未处理 Promise rejection |
| AC-08 | 元素从 DOM 移除再插入 | 资源正确销毁/重建，不重复注册监听器 |
| AC-09 | 页面创建并销毁多个实例 | 实例互不干扰，无持续 RAF/音频节点泄漏 |
| AC-10 | React/Vue props 更新和卸载 | 状态同步，卸载后完全销毁 |
| AC-11 | 375px 宽移动端使用 floating | 不溢出视口，不遮挡预留安全区 |
| AC-12 | 浏览器不允许自动播放 | 返回可识别错误或等待用户手势，不伪装成功 |

## 12. 测试责任

每个任务的作者负责同层测试，不能把测试统一留到联调阶段。

- AI-A 负责状态机、Rive 适配、音频竞态、资源释放的单元和集成测试。
- AI-B 负责 Custom Element、布局、跨框架示例和 Playwright 测试。
- 双方共同维护一组契约测试，同一测试套件分别运行 FakeRenderer 和 RiveRenderer。
- 缺陷由发生层的负责人修复；如果是契约歧义，先补充本文再修复代码。

最低质量门禁：

```text
typecheck
unit test
production build
Playwright smoke
```

覆盖率不作为唯一指标，但 `state-machine`、`controller` 和 Web Component 生命周期的分支必须覆盖。

## 13. Git 与协作流程

建议使用短生命周期分支和小 PR：

```text
codex/avatar-core-<topic>
codex/avatar-embed-<topic>
```

合并规则：

1. 先合并包骨架与公共契约，再并行合并内部实现。
2. 单个 PR 聚焦一个可验证能力，避免 Core、组件和示例同时大改。
3. 修改公共 API、事件名、manifest schema 时，必须由另一位开发者批准。
4. PR 必须写明验证命令、兼容影响和手工截图/录屏（涉及视觉时）。
5. 不允许示例直接引用 `src` 私有路径；必须从公共入口或正式 build 引用。

推荐合并顺序：

1. `package scaffold + public contracts`
2. `fake renderer/audio + component shell`
3. `core state machine + embed layout`
4. `rive renderer + SDK/framework examples`
5. `audio analyser + E2E acceptance`
6. `docs + release candidate fixes`

## 14. 风险登记

| 风险 | 影响 | 缓解措施 | Owner |
| --- | --- | --- | --- |
| Rive 资源尚未定稿 | 阻塞视觉联调 | 使用 manifest 和 FakeRenderer；先以占位资源验收接口 | AI-A |
| 浏览器自动播放限制 | `speak()` 首次调用失败 | 提供 `unlockAudio()` 或在首次用户手势中初始化 | AI-A |
| 音频跨域失败 | 嘴型分析或播放不可用 | 文档明确 CORS；错误事件区分 network/CORS | AI-A |
| 宿主 CSS/层级冲突 | 嵌入显示异常 | Shadow DOM、可配置 z-index、E2E 压力样式页 | AI-B |
| 多份 SDK 重复注册元素 | 运行时异常 | 使用 `customElements.get()` 防重复定义 | AI-B |
| 公共 API 在并行开发中漂移 | 双方返工 | M0 冻结、契约测试、跨 Owner Review | 共同 |
| SDK 体积过大 | 部门项目拒绝接入 | Rive runtime 按需加载，角色资源外置，输出体积报告 | AI-B |
| 实例销毁不完整 | 内存和 CPU 泄漏 | 幂等 destroy、监听器登记表、重复挂载 E2E | 共同 |

## 15. Definition of Done

第一阶段只有同时满足以下条件才算完成：

- 第 1 节的十项交付目标全部满足。
- 第 11 节验收用例全部通过或存在经批准的非阻断豁免。
- 公共 API 和事件有版本号为 `1` 的文档。
- Vanilla、React、Vue 示例能从干净环境启动。
- 构建产物不依赖 Pi/Agent runtime，且未打包 React/Vue。
- 数字人和音频资源失败时有明确错误事件。
- 连续创建、播放、打断、销毁没有明显资源泄漏。
- 验收人能依据接入文档在 15 分钟内把数字人嵌入一个空白 HTML 页面。

## 16. 为第二阶段保留但不实现的接口

为了方便后续 Agent 接入，第一阶段仅保留扩展位置，不提前实现业务：

- `AvatarController` 的命令输入保持可序列化，便于映射 WebSocket/SSE/postMessage。
- DOM 事件可以被宿主 Adapter 转换为 Agent 事件。
- `speak()` 输入未来可兼容 `visemes`、`text` 和流式音频描述。
- 消息协议未来必须带 `source`、`version`、`type`、`requestId` 和 `payload`。
- iframe transport、Agent Adapter 和 TTS Adapter 进入后续阶段，不能侵入 Core。

第一阶段不得为尚未确定的 Agent 事件格式增加 Pi 专属类型或逻辑。
