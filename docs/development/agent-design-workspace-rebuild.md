# Agent 设计页真实性收口与 UI 重构任务单

状态：待实施  
范围：管理台 Agent 列表、Agent 详情、Revision、关联应用、最近调试和发布抽屉  
实施分支：`feature/agent-design-workspace-rebuild`  
基线：从包含本文档的最新 `origin/main` 创建

## 1. 目标

1. Agent 设计页只展示真实、可持久化、可执行或明确标注暂不可用的能力。
2. 删除 Mock、失效开关、原始 JSON、过期控制器和误导性文案。
3. 重组 Agent 详情的信息架构，并统一迁移到现有 Aurora Design System。
4. 保持 Agent Revision、管理员 Chat、发布应用和发布 Chat 的现有行为不变。

## 2. 强制边界

- 三个阶段必须串行实施、分别提交、分别验证，不合并成一个大提交。
- 不修改控制台 Chat 与发布 Chat 的共享消息组件和样式。
- 不修改 Runtime 的 text/thinking 流式、reasoning 默认解析和会话隔离语义。
- 不新增 Skill、MCP、知识库检索、Web Search 或语音 Runtime 功能。
- 不新增或猜测后端 DTO；如确需改变契约，暂停并报告。
- 生产页面只能读取真实 Control API，不得引入 Mock 或推断数据。
- 保留用户已有配置；禁止通过隐藏控件静默删除工具或知识库引用。

## 3. 阶段一：功能真实性收口

建议提交：`fix(agent): remove misleading configuration surfaces`

### 3.1 删除旧 Mock Agent 列表

- 当前生产入口保留 `packages/web/src/admin/aurora/agent-list-view.tsx`。
- 确认无生产引用后，删除旧 `packages/web/src/admin/agents/agent-list.tsx` 及专属无用代码。
- `packages/web/src/admin` 中不得再出现 `MOCK_AGENTS` 或 `agent_demo_*` Agent 列表数据。

### 3.2 收起不会持久化的能力开关

- 从表单移除 `citations`、`realtime`、`webSearch` 三个开关；协议兼容字段暂不删除。
- 保留 `attachments`、`avatar`、`liveSpeech`。
- `liveSpeech` 标注为实验性/未纳入当前文本版本验收，不能暗示已正式可用。
- 隐藏字段不得导致加载后自动 dirty，也不得在保存时意外改变旧值。

### 3.3 工具与知识库

- 删除逗号分隔的任意 ID 输入框，不允许新增未经验证的 ID。
- 无引用时显示真实空态和“尚未产品化”。
- 有既存引用时以只读标签显示，并提供明确的单项移除或全部移除操作。
- 未被用户移除的引用保存时必须保留。
- 不伪造名称、健康状态或连接成功。

### 3.4 Revision Diff

- Revision 列表只显示真实元数据。
- 点击“查看 Diff”时按需调用 `GET /api/control/v1/agent-definitions/:agentId/revisions/:revision`。
- 使用详情接口的真实 `configSnapshot`、`diffFromPrevious`，不得由前端猜测。
- 提供行内 loading、错误、重试和已加载详情缓存。
- Revision 1 显示“初始版本”；后续 Revision 不得错误显示为“首次”。
- 展示变更摘要、Prompt/模型/思考参数、工具、知识库与能力变化；长 Prompt 折叠。

### 3.5 最近调试

- “调试记录”改为“最近调试”或“调试入口”。
- 明示这里只是当前浏览器记住的最近管理员调试会话，不是历史日志。
- 有会话时提供进入管理台 Chat 的操作；不能保证自动选中当前 Agent 时必须如实说明或先报告路由缺口。
- 不展示无法指导用户操作的内部 UUID。

### 3.6 发布语义

- 明确“创建 Published App Version”与“激活上线”是两个动作。
- 成功标题使用“应用版本已创建，尚未激活”，提供“前往应用详情”和“关闭”。
- 配置摘要按字段展示模型、思考、Prompt 摘要、Avatar、附件、语音及工具/知识库阻断状态，禁止直接 `JSON.stringify`。
- 有未保存草稿时继续禁止发布，并解释原因。

## 4. 阶段二：信息架构重构

建议提交：`refactor(agent): reorganize design workspace`

### 4.1 页面结构

- 页面头部：名称、当前 Revision、更新时间、关联应用数、最近调试、发布。
- 一级 Tab：设计、Revision、发布应用、最近调试。
- 原“配置”改名“设计”。

### 4.2 设计 Tab 顺序

1. 基本信息：名称、描述、Revision、更新时间；接口不支持编辑时只读展示。
2. 指令：System Prompt、说明、字符计数、空值/超长状态。
3. 模型与思考：模型选择在前，Provider/能力摘要、开关、默认思考强度在后。
4. 输入输出能力：附件、Avatar、实验性实时语音。
5. 扩展能力：工具、知识库及后续 Skill/MCP 的只读真实状态。

模型必须使用严格选择器，不允许自由输入任意 Model ID。当前模型已从目录移除时保留原值并显示不可用，不得静默换模型；目录加载失败必须显示错误。

### 4.3 保存栏

- 使用固定或吸底操作栏，包含状态、变更摘要、放弃修改和“保存为新 Revision”。
- 覆盖 saved、dirty、saving、error；失败保留草稿，保存中禁止重复操作。
- 离开页面前有未保存修改时提示；切换 Tab 不丢内存草稿。

### 4.4 Revision 与应用

- Revision 表格展示 Revision、变更摘要、时间、创建人、关联发布版本数和操作。
- 最新 Revision 明确突出；Source Hash 只放次级详情，不铺满主表。
- 发布应用展示名称、状态、当前激活版本、Public App ID，并能进入应用详情。
- 空状态提供前往应用管理入口，不重复实现应用管理。

## 5. 阶段三：Aurora UI 统一

建议提交：`feat(agent): migrate workspace to aurora UI`

- 为 Agent Workspace 建立独立 CSS Module；不要继续把页面专属样式堆入全局 `admin/styles.css`。
- 复用现有 Aurora PageHeader、Button、Badge、表格、空状态、表单和 Dialog 规范，不另建设计系统。
- 页面头部右侧放“继续调试”和主按钮“发布”；有草稿时发布禁用并说明。
- Tab 使用正确语义、键盘操作和清晰焦点，不再使用无样式按钮行。
- 分区、Label、说明、错误和控件形成稳定层级；删除行内布局样式。
- 保存栏桌面吸底、窄屏换行；长 Prompt、模型名和错误不撑破页面。
- Revision/应用表格与 Agent 列表一致，窄屏可滚动或使用紧凑布局。
- 发布抽屉只保留一个 dialog 语义，具备焦点进入/返回、Escape、重复提交保护和错误重试。
- 验证 1440、1024、768、390px；不得整体横向溢出，保存和发布操作必须可达。
- 遵守 `prefers-reduced-motion`，加载使用 live region，错误使用 `role="alert"`。

## 6. 必须覆盖的测试

### 表单与状态机

- 模型目录正常、失败、当前模型已下架。
- reasoning 支持/不支持、可关闭/不可关闭。
- 三个无效能力开关不再渲染。
- 工具/知识库不能新增任意 ID，已有引用可安全移除且不会被静默删除。
- saved → dirty → saving → saved；保存失败、重试、放弃、保存中禁止编辑。
- Tab 切换不丢草稿，离开未保存提示生效。

### Revision、发布与页面状态

- Revision 列表、空态、按需详情、Diff 失败/重试、缓存、初始版本与真实后续 Diff。
- 有草稿、无关联应用、无 Revision、创建成功未激活、失败重试。
- 发布摘要不含原始 JSON。
- Agent 详情 loading、401/404、网络失败和重试。
- Agent 列表只读真实 API，仓库无 Mock Agent 列表。

## 7. 验证命令

在 `runtimes/pi` 执行：

```bash
npm run typecheck --workspace=@earendil-works/pi-web
npm test --workspace=@earendil-works/pi-web
npm run build:admin --workspace=@earendil-works/pi-web
git diff --check
git status --short
```

若改动 Revision 后端逻辑，再执行：

```bash
npm run typecheck --workspace=@earendil-works/pi-server
node node_modules/vitest/dist/cli.js --run packages/server/test/publishing/control-service.test.ts
```

## 8. 阶段门禁与汇报

每完成一个阶段先停止，不自动进入下一阶段；提交以下信息等待验收：

```text
阶段：
基线提交：
完成内容：
未完成内容：
删除的误导/遗留代码：
改动文件：
测试命令与结果：
浏览器验收：
已知风险：
提交号：
是否建议进入下一阶段：
```

核心原则：宁可明确显示“暂不可用”，也不能保留一个看起来可以配置、实际不会生效的控件。
