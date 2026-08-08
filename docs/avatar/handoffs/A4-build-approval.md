# A4 交接：Avatar 构建入口审定

状态：Approved for B2  
Owner：AI-A  
输入：`B0-contract-usage-checklist.md`、`B1-to-A4-handoff.md`

## 审定结果

现有单包多入口方案通过 A4。正式 ESM 构建入口为：

```text
@skdy/avatar                → dist/index.js
@skdy/avatar/core           → dist/core/index.js
@skdy/avatar/web-component  → dist/web-component/index.js
@skdy/avatar/react          → dist/react/index.js
@skdy/avatar/testing        → dist/testing/index.js
```

`@skdy/avatar/package.json` 直接发布源 package.json，不参与 Vite 构建。

## A4 修正

1. 将 `testing/index` 加入 Vite 多入口，使所有运行时入口处于同一个 Rollup 图中。
2. 增加跨入口 `AvatarError` 类身份测试，避免 testing 与根入口各打包一份类。
3. `npm test` 先清理 dist，再生成纯 tsc 测试产物，避免此前 Vite bundle 污染深路径测试。
4. 保留 Vite 共享 chunk。它保证公共代码和类身份跨入口唯一；CDN 部署必须上传完整 dist，而不是只复制入口文件。

## 冻结规则

- React 保持 optional peer dependency，并由 Rollup external 排除。
- Rive 等未来 renderer SDK 不得进入 root/core/testing，具体 renderer 后续应隔离加载。
- Vite Library Mode 会内联静态 import 的资源，因此禁止在源码中 import 角色或媒体文件；必须通过 Manifest URL/CDN 加载。构建测试扫描 dist 的全部 JavaScript chunk，发现媒体 data URI 即失败。
- B2 只填充 `src/web-component/index.ts` 及其所有权目录，不修改 Vite entries 或 package exports。
- B5 只填充 React 入口；不得把 React 打入其他入口。
- 共享 chunk 文件名可带 hash；静态/CDN 部署必须原样发布 dist 的全部文件。

## B0 疑问答复

- Q1：`interrupt()` 在 B2 中固定转发 `source: "host"`；`"user"` 为未来内部 UI 保留。
- Q2：无活动语音时仍派发 `avatar-interrupted` 是有意行为，B2 原样镜像。

## B2 启动条件

B2 可以启动。开始前必须阅读：

1. `docs/avatar/handoffs/B0-contract-usage-checklist.md`
2. `docs/avatar/handoffs/A3-testing-fixtures.md`
3. 本交接单

B2 使用 `@skdy/avatar/testing`，不得深路径导入 Core/Renderer，也不得修改构建入口。
