# A5 交接：Rive Renderer

状态：Complete  
Owner：AI-A  
依赖：A2 Renderer boundary  
后续：A6 Character Manifest loader/validation

## 实现入口

- `packages/avatar/src/renderers/rive/rive-renderer.ts`
- `packages/avatar/src/renderers/rive/runtime.ts`
- `packages/avatar/src/renderers/rive/index.ts`

这些入口是包内接口，不属于消费者 package exports。

## 已实现能力

- 从已解析 Manifest 的 `assetUrl` 加载 `.riv`。
- 启动 Manifest 指定的单个 State Machine。
- Boolean、Number、Trigger 三种状态映射。
- Number `audioLevel` 输入。
- CSS 尺寸和 DPR resize。
- Load error、无效 mapping、重复 mapping 和错误 input type。
- AbortSignal 取消、直接 destroy 取消、WASM cleanup、Canvas 移除。
- 幂等 initialize/destroy 和销毁后调用保护。
- Node CommonJS 形态与浏览器 bundler ESM 形态兼容。

## A6 输入约束

A6 将 Manifest 交给 Renderer 前至少验证：

- `renderer === "rive"`
- `assetUrl` 和 `stateMachine` 为非空字符串
- `inputs` 只包含标准 AvatarState 与 `audioLevel`
- input 名称为非空字符串
- 映射值无重复

实际 `.riv` 是否存在对应 input 仍由 Renderer 加载后验证。

## 验证

```text
TypeScript typecheck：通过
全部单元/组件测试：56/56
构建测试：6/6
npm pack --dry-run：通过
npm audit：0 vulnerabilities
```

新增测试覆盖加载、三类状态 input、audioLevel、resize、无效 mapping、加载失败、外部 abort、直接 destroy 和生命周期错误。

## 已知限制

- 尚未接入生产 Controller composition；由 A6/A7 后续组合。
- 尚未使用真实 `.riv` 资产做浏览器冒烟；A9/B7 处理。
- 当前使用 Rive legacy State Machine Inputs；未来 Data Binding 迁移被限制在 Renderer 内。
