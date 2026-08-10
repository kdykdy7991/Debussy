# A6 任务单：Character Manifest 加载与校验

状态：Complete（2026-08-10）  
执行者：AI-A（强模型/技术负责人）  
前置：A5 已完成  
任务边界：实现内部 Manifest loader/validator；不实现音频、Embed SDK、示例或 Agent 协议。

## 1. 开始前必须阅读

1. `docs/avatar/PHASE-1-DEVELOPMENT-PLAN.md`
2. `docs/avatar/decisions/0001-public-contract-and-package-exports.md`
3. `docs/avatar/decisions/0002-renderer-boundary.md`
4. `docs/avatar/handoffs/A5-rive-renderer.md`
5. `packages/avatar/src/core/types.ts`
6. `packages/avatar/src/core/errors.ts`
7. `packages/avatar/src/renderers/types.ts`

## 2. 允许修改

- `packages/avatar/src/manifest/**`（推荐新目录）
- Manifest 必需的内部 runtime 辅助类型
- `packages/avatar/test/manifest*.test.mjs`
- 内部类型契约测试
- `docs/avatar/decisions/` 中 A6 必需的 ADR
- `docs/avatar/handoffs/A6-character-manifest.md`

不得从根入口、core、web-component 或 react 新增 Manifest loader 公共导出。

## 3. 必须实现

提供可依赖注入 fetch 的内部加载器，输入为 `CharacterManifest | string`，输出始终为已校验的 `CharacterManifest`。

### 对象输入

- 不发起网络请求。
- 必须验证普通对象结构，不能只靠 TypeScript 类型断言。
- `id`、`version`、`assetUrl`、`stateMachine` 必须是 trim 后非空字符串。
- `renderer` 第一阶段只能是 `"rive"`。
- `inputs` 必须是普通对象；key 只能是五种 `AvatarState` 或 `audioLevel`。
- 每个映射值必须是非空字符串，且映射值不能重复。
- `inputs` 仍允许部分映射，不强制五种状态齐全；Demo 完整性由 A9 负责。

### URL 输入

- URL 必须是非空字符串。
- 使用注入的 fetch，并把调用方 `AbortSignal` 原样传递。
- 非 2xx、网络/CORS、响应读取和 JSON 解析失败映射为 `CHARACTER_LOAD_FAILED`。
- 成功解析但 schema 非法映射为 `INVALID_MANIFEST`。
- 相对 `assetUrl` 按最终响应 URL（含重定向后的 `response.url`）解析为绝对 URL。
- 不静默吞掉底层 cause；公共错误必须是 `AvatarError`。

### 错误和安全

- 错误 message 指明失败字段，但不得回显整份 Manifest。
- 不执行 Manifest 中的字符串，不支持任意 renderer 名或额外脚本 URL。
- loader 自身不缓存；浏览器 HTTP 缓存负责重复 URL，避免跨实例共享失败 Promise。

## 4. 必须新增的测试

至少覆盖：合法对象不 fetch；合法 URL 与 signal；相对 asset URL；404/fetch/JSON 错误；缺字段/错误 renderer；非法 input key、空名称和重复映射；部分 inputs；abort；A5 renderer 仍只接收已解析对象。

## 5. 验收与验证

运行 `npm run typecheck`、`npm test`、`npm run test:build`、`npm pack --dry-run`、`git diff --check`。

验收要求：无公共 API 变化；Rive 不进入基础入口；错误码只使用已冻结集合；所有分支可通过注入依赖确定性测试。

## 6. 停止条件与交接

需要修改 Manifest schema、增加 renderer 类型、增加错误码或把 loader 暴露给消费者时，先提交契约变更请求。

创建 `docs/avatar/handoffs/A6-character-manifest.md`，列出内部入口、验证规则、错误矩阵、测试、已知限制和提供给 A6-PREVIEW/A9 的使用示例。完成后等待 Review；通过后启动 A6-PREVIEW，不启动 A7。
