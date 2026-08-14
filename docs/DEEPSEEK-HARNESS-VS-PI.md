# DeepSeek Harness 的时空可组合性实践及其与 Pi Agent 的对比

## 结论摘要

DeepSeek Harness 明确体现了论文《A Programming Paradigm for Spatiotemporal Composability》的思想，而且不是停留在概念或 API 命名层面：它把论文中的“组件—纤程—上下文—可撤销效应—反应式余效应”直接实现为 Cordis 插件运行时，再把 Agent loop、模型适配器、工具、会话日志、权限、沙箱和 UI 等能力都组装成该运行时中的插件。

Pi Agent 也有成熟的扩展、事件、工具注册和 `/reload` 机制，但它的核心抽象不同：Pi 是一个固定的 Agent/Agent loop 加上一套面向产品功能的 Extension API；DeepSeek Harness 是一个通用动态组件运行时，Agent 只是其中一种可替换的组合。二者最核心的差别不是“有没有插件”，而是插件是否拥有统一的效应归属、依赖声明、依赖变化后的自动生命周期协调，以及能否按单个组件粒度卸载。

对我们当前基于 Pi 的系统而言，Pi 的优势是小而直接、模型生态广、终端交互成熟、扩展开发成本低；DeepSeek Harness 的优势是能力解耦、局部热替换、每会话组合、可恢复生命周期和自修改基础更系统。若目标是继续做单一、稳定的编码 Agent，Pi 更经济；若目标是长期演化成多 Agent、多租户、能力按会话装配并允许运行时自修改的平台，DeepSeek Harness 的架构更接近目标状态。

## 分析范围与版本

- DeepSeek Harness：`/home/hello/workspace/deepseek-harness`，提交 `47f943859b`。
- 当前 Pi Agent：`/home/hello/workspace/skdy-agent/runtimes/pi`，提交 `fceec12`。
- 论文中文译读：[paper.zh.md](../runtimes/deepseek-harness/docs/paper.zh.md)。
- 本文是源码静态分析，没有运行真实模型或端到端场景。

文中的“论文保证”与“工程实现”需要区分：论文在独立性、正确逆操作、有限执行、依赖无环等前提下给出形式化性质；代码通过 disposer、生命周期状态和依赖通知实现这些思想，但不能自动撤销绕过 Cordis 的全局变量写入、不可逆外部请求或失控子进程。

## 一、论文思想在 DeepSeek Harness 中如何体现

### 1. 统一上下文是系统的能力容器

论文把效应上下文和余效应上下文统一为同一个 `Context`。DeepSeek Harness 也以 Cordis `Context` 为中心：插件向 `ctx` 提供服务，消费者按稳定键读取服务，事件和效应同样挂在该上下文上。

Harness 架构文档明确说明，插件向共享上下文贡献服务、类型化事件和可撤销效应；模型适配器、工具注册表、会话日志乃至 Agent loop 本身都是插件。证据见：

- `/home/hello/workspace/deepseek-harness/docs/architecture.md:9-13`
- `/home/hello/workspace/deepseek-harness/docs/cordis-primer.md:7-14`

这对应论文的“上下文范式”：组件不是直接依赖具体实现，而是通过上下文提供和消费能力。

### 2. Fiber 是论文组件实例的直接工程映射

论文区分可复用的 component 与一次运行时实例 fiber。Cordis 的 `Fiber` 也正是一个插件的运行时实例，持有：

- 派生上下文 `ctx`；
- 验证后的配置；
- 所需服务 `inject`；
- 当前生命周期状态；
- 已解析服务快照；
- 正在进行的加载/卸载任务；
- 该实例拥有的 disposer 集合。

源码证据：`/home/hello/workspace/deepseek-harness/vendor/cordis/src/fiber.ts:181-203`。

这使“组件拥有其全部运行时贡献”成为可执行的数据结构，而不是开发约定。

### 3. `ctx.effect()` 实现可撤销效应

论文中的可撤销效应同时产生正向变换和逆变换。Cordis 中，effect body 执行注册或资源申请，并返回 disposer 作为逆操作：

```ts
ctx.effect(() => {
  const resource = acquire()
  return () => release(resource)
})
```

Cordis 接受单个 disposer、异步 disposer，或同步/异步迭代器逐步产出的多个 disposer。纤程卸载时按注册的相反顺序执行清理，并等待异步清理完成。证据见：

- effect 与 disposer 类型：`vendor/cordis/src/fiber.ts:68-93`；
- effect 收集与逆序撤销：`vendor/cordis/src/fiber.ts:402-442`；
- 建立过程失败时回滚已收集效应：`vendor/cordis/src/fiber.ts:517-548`。

这分别对应论文中的逆变换、后进先出恢复、迭代效应、异步转换和失败回滚。

DeepSeek Harness 还把这项机制上升为仓库规则：所有注册都必须通过 `ctx.effect()` / `ctx.on()`，注册表的 `register()` 必须返回 disposer。换言之，工具、提示词片段、模型适配器、事件监听器和服务提供都应该被纳入统一效应所有权。

### 4. `inject`、`provide` 与 `notify` 实现反应式余效应

插件通过 `inject` 声明所需服务，服务提供者通过 `ctx.provide()` 注册实现。`provide()` 本身也是一个 effect，因此服务与提供它的 fiber 生命周期绑定：提供者卸载时，服务自动移除。

服务出现或消失后，`notify()` 会遍历依赖该服务的 fibers，重新解析依赖并调用 `_refresh()`。证据见：

- 服务注册及卸载通知：`vendor/cordis/src/reflect.ts:267-305`；
- 查找依赖者并刷新：`vendor/cordis/src/reflect.ts:307-335`；
- Fiber 保存依赖实现快照：`vendor/cordis/src/fiber.ts:197-200`。

这不是普通依赖注入容器的“一次性 resolve”。它对应论文的反应式余效应：组件声明自己观察哪些上下文键；这些键的提供者改变时，运行时重新协调消费者生命周期。

### 5. 隔离与拦截形成局部上下文

Cordis 为每个 fiber 从父上下文派生子上下文，并能对注入服务建立 intercept 配置。服务键还通过 isolation symbol 解析，因此不同上下文分支可以看到不同服务实现。源码入口见：

- fiber 派生上下文及 intercept：`vendor/cordis/src/fiber.ts:234-245`；
- 服务读取按 isolate key 查找：`vendor/cordis/src/reflect.ts:225-242`。

这对应论文的 isolation 和 interception，使“同一进程中的不同 Agent/插件组合看到不同能力集合”成为可能。需要注意，它是能力可见性和生命周期隔离，不等于恶意代码安全沙箱；真正的不可信执行仍依赖 Harness 的 sandbox、filesystem 和 subprocess provider。

### 6. Loader、配置协调与 HMR 对应动态组合演算

DeepSeek Harness 不是在代码中硬编码启动顺序，而是从分层 `cordis.yml` 组装插件树。Profile、bundle、用户 patch 和命令行 overlay 依次生成目标组合，配置项可以被替换或插入。证据见 `docs/architecture.md:15-37`。

Loader 负责让当前插件树向声明的目标配置收敛；HMR 用相同的卸载/重载生命周期替换模块。由于注册都属于 fiber effect，旧实现卸载时先撤销其贡献，新实现再激活，依赖者随服务变化重新协调。这是论文“目标视图—撤回—重新激活—静止状态”的工程版本。

### 7. Agent 本身也是可组合能力，而非特权核心

DeepSeek Harness 将以下模块分别作为 Cordis 服务或插件：

| 能力 | 典型上下文键 |
|---|---|
| 会话事件日志 | `ctx.sessions` |
| System Prompt 组装 | `ctx.systemPrompt` |
| 工具注册与执行 | `ctx.tools` |
| Agent 注册 | `ctx.agents` |
| 默认 Agent loop | `ctx.agentLoop` |
| 模型流式适配 | `ctx.llm` |

完整表见 `docs/architecture.md:39-50`。默认 loop 只是 `Agent` 接口的一种 provider，可以从组合中替换；文件系统、shell、subprocess、sandbox、subagent、compaction、plan、goal 等也按 Service Definition / Provider / Consumer 拆分。

这比“Agent loop 提供一些 hook”更彻底：loop 自己也在插件树中，没有不可替换的产品核心。

### 8. 会话事件日志提供稳定状态平面

动态卸载插件不应意味着丢失会话事实。Harness 把 `SessionEvent` append-only log 作为模型历史、恢复、分叉、UI 和持久化的共同事实源，并规定“模型可见即必须可从日志重建”。证据见 `docs/architecture.md:87-92`。

这与时空可组合性互补：插件及其暂态注册可以卸载，已提交的会话事实仍由独立持久化平面保存。插件重载后可以从日志投影当前状态，而不是依赖旧对象留在内存。

### 9. 自修改是动态组合能力的直接应用

`dsh-tool-cordis` 允许 Agent 检查当前 Cordis 运行时，并在内存中挂载或卸载模型编写的插件。示例说明见：

- `/home/hello/workspace/deepseek-harness/examples/web-cordis/README.md`
- `/home/hello/workspace/deepseek-harness/packages/extensions/tool-cordis/README.md`

这里的关键不是“模型能写 TypeScript”，而是新代码进入统一 fiber 生命周期：它的注册有所有者，卸载时能够撤销，服务变化能够通知依赖者。论文所说的 self-evolving agent harness 因而有了比“改文件后重启”更细的运行时基础。

### 10. 实现与论文之间仍有边界

DeepSeek Harness 体现论文思想，不代表任意插件都自动满足论文所有前提：

- disposer 的语义正确性仍由具体资源实现保证；错误 disposer 无法恢复原状态。
- 绕过 `ctx.effect()` 的全局修改不会被自动跟踪。
- HTTP 请求、外部数据库写入等通常不可逆，只能采用补偿操作或接受系统边界。
- 相互依赖、共享可变状态和非交换效应会削弱局部卸载保证。
- Cordis context isolation 不是 OS 安全边界。

因此，更准确的表述是：Harness 把论文要求变成默认架构和可检查的编码约束，并为满足前提的组件提供统一生命周期；它没有消除不可逆世界本身。

## 二、DeepSeek Harness 与当前 Pi Agent 的核心差异

### 总览

| 维度 | DeepSeek Harness | Pi Agent | 实际影响 |
|---|---|---|---|
| 核心定位 | 通用、插件化 Agent Harness 平台 | 最小化终端 Coding Agent | DSH 更像可组装操作系统，Pi 更像可扩展应用 |
| 基础抽象 | Context + Service + Plugin + Fiber + Effect | Agent + Agent loop + Extension API | DSH 从生命周期和依赖出发，Pi 从产品扩展点出发 |
| 核心是否可替换 | Agent loop、会话、工具、LLM 等都是插件 | Agent loop 与 Session 主体固定，扩展围绕它们注册 | DSH 可替换深层基础设施，Pi 改核心行为常需改内部或使用既定 hook |
| 注册所有权 | 每项注册是 fiber 拥有的可撤销 effect | 注册项存入 Extension 的 maps；重载时替换 ExtensionRunner | DSH 支持统一、局部 disposer；Pi 主要靠整套扩展运行时重建 |
| 依赖模型 | `inject` 声明服务，提供者变化自动刷新消费者 | 扩展拿到一个聚合 API/context，没有通用服务依赖图 | DSH 能响应能力拓扑变化；Pi 多由调用顺序和宿主显式协调 |
| 重载粒度 | 可卸载单个 fiber、配置行或插件子树 | `/reload` 重载 settings/resources/extensions，替换 runner | DSH 更适合局部 HMR；Pi 重载简单但粒度较粗 |
| 配置组合 | profile + bundle + `cordis.yml` + patch overlay | settings + extensions/skills/prompts/themes + Pi packages | DSH 配置描述运行时拓扑；Pi 配置描述应用资源和扩展 |
| 每会话能力 | preset、scope、isolate 可为 Agent 组合不同服务 | 一个 AgentSession 绑定一套 runner/tools，扩展上下文面向当前会话 | DSH 的 scope 是运行时原语；Pi 可实现但主要靠 Session 宿主编排 |
| 事件 | typed event domains，支持 emit/waterfall/parallel/serial | Extension event union + handlers，部分事件可返回改写/阻断结果 | 两者均强；DSH 的事件也属于 effect 并跨服务 seam 组织 |
| 工具管线 | 工具注册表、执行策略、approval 等是插件 seam | Agent config tools + `beforeToolCall`/`afterToolCall` + Extension tools | Pi 更直接；DSH 更容易替换完整执行链或按 scope 分层 |
| 会话模型 | append-only `SessionEvent` 是统一事实源，模型可见即记录 | JSONL tree entries；Agent 内存 messages 与 SessionManager 协调持久化 | 两者都重视可恢复性；DSH 更事件溯源化，Pi 的树导航 UX 更成熟 |
| 模型支持 | 当前架构以 DeepSeek provider seam 为中心，可加适配器 | 大量内置 provider、模型目录、OAuth 和 transport | Pi 在现成模型生态上明显领先 |
| UI | Web/headless/ACP/JSON-RPC 由不同 bundle 组合 | TUI/print/JSON/RPC/SDK，终端体验是核心产品 | DSH 更服务化，Pi 的本地终端交互更完整 |
| 自修改 | 提供运行时检查、定义、挂载、卸载插件能力 | 扩展/技能可被生成并通过 `/reload` 加载 | DSH 是局部动态组合；Pi 更接近生成资源后整体重载 |
| 子 Agent/计划等 | 作为正式 capability seams 和组合包存在 | 核心刻意不内置，通常由第三方 extension 实现 | DSH 偏平台完整性，Pi 偏最小核心与用户选择 |
| 安全 | fs/subprocess/sandbox/approval 拆成 provider 与 policy | project trust、tool preflight、bash 工具与宿主策略 | DSH 更适合替换本地/E2B 等执行世界；Pi 的本地安全路径更直接 |
| 复杂度 | 包多、抽象层多、配置和生命周期学习成本高 | 核心较小，Extension API 易理解 | DSH 的系统性以更高开发/运维复杂度为代价 |

### 1. “插件系统”不是同一种插件系统

Pi Extension 可以注册工具、命令、快捷键、事件处理器、provider 和 UI renderer。其 API 很丰富，源码接口见：

- `runtimes/pi/packages/coding-agent/src/core/extensions/types.ts:1200-1430`
- 注册结果按 extension 保存为 handlers/tools/commands 等 maps：`types.ts:1680-1694`

这些注册在产品层面非常实用，但没有统一返回 disposer，也没有把每次注册抽象成可嵌套的 effect。Pi `/reload` 的流程是通知旧扩展 `session_shutdown`、重载资源、创建新的 `ExtensionRunner`，再发送新的 `session_start`。证据见 `runtimes/pi/packages/coding-agent/src/core/agent-session.ts:2778-2800`。

因此 Pi 的时间可组合性主要位于“整个 Extension runtime/session 边界”；Cordis 则把时间可组合性下沉到每个 fiber 和每项注册，能够单独 dispose 一个插件实例并等待其逆操作完成。

Pi 并非完全没有清理：`session_shutdown` 允许扩展主动释放外部资源，provider 也提供显式 unregister，UI component 可实现 `dispose()`。区别在于这些是分散在具体 API 中的生命周期协议，而不是所有贡献都服从同一个效应代数和 owner。

### 2. Pi 的扩展上下文是操作门面，Cordis Context 是反应式能力图

Pi 的 `ExtensionContext` 提供 model、session、UI、消息、工具、compact、reload 等宿主操作。它方便扩展直接完成任务，但扩展不能以统一方式声明“只有 `filesystem` 和 `approval` 服务同时存在时才激活”，也不会因为某个服务 provider 被替换而自动停用、重新解析并激活。

Cordis `inject` 是声明式余效应；`ctx.provide`、isolate 和 notify 共同形成运行时服务拓扑。这让 DSH 可以把 LLM、filesystem、subprocess、sandbox 或 subagent 后端替换为不同 provider，并由消费者按依赖自动协调。

### 3. Pi Agent loop 是库核心，DSH Agent loop 是默认 provider

Pi 的低层 `agentLoop()` 是一个明确的固定流程：维护 message context，调用 stream function，执行工具，追加 tool results，处理 steering/follow-up，再进入下一轮。证据见 `runtimes/pi/packages/agent/src/agent-loop.ts:95-240`。

Pi 暴露了很多实用 hook，例如 `transformContext`、`convertToLlm`、`beforeToolCall`、`afterToolCall`、`shouldStopAfterTurn`，Coding Agent Extension 还可监听更多 lifecycle events。这适合在稳定循环上增加策略。

DSH 把 loop 本身放在 `ctx.agentLoop` 后面；新行为优先作为相邻插件挂到 `agent/*`、`tools/*` 或 capability event 上，必要时可以替换整个 loop provider。它更适合研究不同 Agent 控制循环或同时托管多种 loop，但也提高了接口设计和一致性维护成本。

### 4. 会话持久化：两者都强，但取向不同

Pi 的 JSONL 会话具有 `id/parentId` 树结构，原生支持 `/tree`、`/fork`、`/clone` 和分支摘要，交互体验成熟。Agent 的 `messages` 是运行时上下文，SessionManager 负责把交互、压缩和自定义条目持久化。

DSH 更强调事件溯源：turn、step、user、assistant、tool 等都是 `SessionEvent`，模型上下文、UI、fork、resume、telemetry 和 persistence 从同一日志投影。它的严格规则“模型可见即已记录”降低重放时隐性上下文丢失的风险。

可以概括为：Pi 的会话模型优先服务用户可导航的对话树；DSH 的会话模型优先服务跨插件、跨前端、跨恢复路径的一致事实流。两者并非互斥，Pi 的树 UX 值得保留，DSH 的模型可见输入可重建不变量值得借鉴。

### 5. 工具和能力扩展的层级不同

Pi Extension 的 `registerTool()` 很适合快速增加 LLM 工具，`tool_call` 和 `tool_result` handler 可做审批、改写与审计。默认 coding agent 直接给出 read/write/edit/bash 等能力。

DSH 通常把一项重要能力拆成：

1. Service Definition：稳定接口；
2. Service Provider：本地、远程或沙箱实现；
3. Consumer：面向模型的 tool 或其他调用方。

例如 filesystem、subprocess、shell、terminal、web 和 subagent 都按这种 seam 组织。这样切换到远程沙箱时，多项 consumer 可以共同迁移到同一个执行世界，而不必各自 fork。代价是增加一个能力远比 Pi 写一个 extension tool 更重。

### 6. 模型与本地 Coding Agent 体验是 Pi 的现实优势

Pi 已内置大量 provider、模型目录、OAuth、API key、transport 和模型切换 UI；其 TUI 包含编辑器、补全、图片、模型选择、thinking level、会话树、主题和扩展 UI。对于“开发者在本地终端使用一个编码 Agent”，这些是直接的产品价值。

DSH 的抽象更适合 provider 替换，但当前代码库的交付重心是 DeepSeek provider 与平台能力组合。仅从当前源码和开箱体验衡量，不能因为 DSH 架构更通用，就推断它在模型覆盖或终端产品成熟度上更强。

### 7. 自修改的安全与一致性路径不同

Pi 可以让 Agent 生成 extension、skill 或 prompt 文件，再执行 `/reload`。重载会把旧 context 标成 stale，旧 extension 在 `session_shutdown` 中清理，然后构造新 runner。这是一条容易理解的“资源重扫描 + 全体扩展重启”路径。

DSH 可以在运行进程中挂载一个新的单独 plugin fiber；它产生的服务和工具马上进入相应 scope，卸载时只撤销该 fiber 的贡献，依赖者按服务变化重协调。这更符合论文的 self-evolving harness，但必须同时承担动态代码执行、能力授权、失败回滚和跨会话影响的治理成本。

## 三、对我们当前 Pi 架构的建议

### 建议保留 Pi 的部分

1. 保留 Pi 的 provider/model 层和成熟 TUI，不要为了抽象一致性重写已经工作的模型接入和本地交互。
2. 保留简单 Extension API 作为高频开发入口。大部分产品扩展并不需要完整 Service Definition / Provider / Consumer 三层。
3. 保留 JSONL 会话树与 `/tree`、`/fork` 的用户体验。
4. 保留低层 Agent loop 的小而可读；常规策略继续使用 hooks，不必一开始把 loop 全部插件化。

### 最值得从 DSH 借鉴的四项机制

#### 1. 为所有注册增加统一 owner 与 disposer

先不引入完整 Cordis，也可以让扩展注册工具、命令、事件、provider、UI 时统一挂到一个 `ExtensionScope`：

```ts
interface ExtensionScope {
  effect(setup: () => void | (() => void | Promise<void>)): () => Promise<void>
  dispose(): Promise<void>
}
```

所有 `register*` 内部自动产生 disposer 并归属到 scope，按逆序清理。这样 `/reload`、单扩展禁用和失败回滚会共享同一条可靠路径，避免仅依赖 `session_shutdown` 由作者手工清理。

#### 2. 把关键基础设施抽成少量有依赖声明的 capability

不必把一切插件化，优先选择未来确实需要替换的能力，例如：

- filesystem；
- subprocess/shell；
- sandbox/approval；
- tool registry；
- model stream provider；
- subagent provider。

消费者声明 required capabilities；provider 变化时，宿主重建受影响消费者，而不是重载全部扩展。

#### 3. 建立“模型可见输入可从会话重建”的不变量

Pi 的 extension 能在 `context` 或 `before_agent_start` 等阶段注入内容。应确保最终进入模型的动态内容在 Session 中有对应事件或可重放条目，否则 resume、fork、审计和问题复现会看到不同上下文。

这项约束可以独立于 Cordis 落地，而且对可靠性收益很高。

#### 4. 将运行时能力作用域化到 Session/Agent

当前产品若走向多会话或多 Agent，应避免一个进程级 extension registry 默认影响所有会话。注册项至少标明 host、session、agent 三种 scope；工具和 prompt 由查看者的 scope chain 合并。这可以为不同 Agent 配置不同技能、权限和沙箱 provider，并降低自修改对其他会话的影响。

### 不建议直接照搬的部分

1. 不要一次性把 Pi 全部模块改造成 Cordis 风格插件；迁移面和认知成本过大。
2. 不要为了形式上的“everything is a plugin”拆分只有一个稳定实现、没有替换需求的内部函数。
3. 不要把 context isolation 当作安全沙箱；不可信插件仍需进程或 OS 级隔离。
4. 不要承诺通用副作用可逆；只对经过托管 API 且 disposer 正确的资源提供保证。
5. 不要牺牲 Pi 的直接扩展体验。可将 capability seam 留给平台级能力，将普通 Extension 保留为上层便利 API。

## 四、推荐的演进路线

### 阶段 1：统一扩展生命周期

- 引入 `ExtensionScope` 和逆序异步 disposer。
- 让 tool、command、event、provider 和 UI 注册自动归属 scope。
- 加入“扩展加载到一半失败时回滚已完成注册”的测试。
- `/reload` 先 dispose 旧 scopes，再建立新 scopes；检测并拒绝 stale context。

这一阶段主要获得时间可组合性，不改变 Agent loop。

### 阶段 2：关键 capability 与依赖图

- 为 filesystem、subprocess、sandbox、tools 建立具名 capability registry。
- 扩展可声明 required/optional capability。
- provider 出现、消失或替换时，只重建依赖它的 extension scope。
- 明确循环依赖与多 provider 选择规则。

这一阶段获得有限但实用的空间可组合性。

### 阶段 3：Session/Agent scope

- 注册项携带 host/session/agent scope。
- 工具、技能、prompt 和权限从 scope chain 解析。
- 每个 Agent 可以选择 capability preset；切换 preset 时保留会话日志，只协调运行时能力。

这一阶段为多 Agent 和多租户准备基础。

### 阶段 4：受控自修改

- 模型生成的新插件先进入隔离构建和静态检查。
- 挂载操作必须经过权限决策，并记录来源、版本和 scope。
- 失败时回滚新 fiber/scope，成功后才发布能力。
- 默认只影响当前 Session/Agent；提升到 host scope 需要显式批准。
- 外部资源必须使用托管 capability，禁止把 context isolation 当成不可信代码边界。

## 五、最终判断

DeepSeek Harness 确实是论文思想的工程实现，核心证据形成了闭环：

```text
论文 component/fiber
        ↓
Cordis Plugin/Fiber（生命周期所有者）
        ↓
ctx.effect + disposer（时间可组合性）
        ↓
ctx.provide + inject + notify（空间可组合性）
        ↓
Loader/HMR/config reconciliation（动态组合）
        ↓
Agent loop、tools、LLM、session 等全部作为插件组合
        ↓
运行时 inspect/mount/unmount（受控自修改基础）
```

Pi 与 DeepSeek Harness 不是简单的“旧版与新版”关系，而是两种取舍：Pi 优先最小核心、终端产品体验和扩展便利；DeepSeek Harness 优先动态组合的系统性、局部生命周期和平台级能力替换。

对我们最合理的方向不是立即从 Pi 切换或完整复制 DeepSeek Harness，而是先把 DSH 最有价值、又能独立落地的机制引入 Pi：统一 effect owner/disposer、关键 capability 依赖、模型可见输入可重建、Session/Agent scope。做到这四点后，再根据多 Agent、自修改和远程沙箱的真实需求决定是否继续走向完整的时空可组合运行时。
