# B5 任务单：React 薄适配器

状态：Ready（B4 已通过 AI-A 二次 Review）  
执行者：AI-B（经济模型/实现者）  
前置：B4

## 1. 公共输出

从现有 `@skdy/avatar/react` 入口导出：

- `PiAvatar`
- `PiAvatarProps`

`PiAvatar` 必须使用 `forwardRef<PiAvatarElement>`，让宿主通过 ref 调用现有 Controller 方法。不得在 React 内复制 Core 状态机或音频/Rive 逻辑。

## 2. Props 冻结

`PiAvatarProps` 至少包含：

- `character: string`
- `state?`, `mode?`, `position?`, `width?`, `height?`, `background?`, `autoplay?`
- `id?`, `className?`, `style?`, `aria-label?`
- 六个事件回调：`onAvatarReady`、`onAvatarStateChange`、`onAvatarSpeechStart`、`onAvatarSpeechEnd`、`onAvatarError`、`onAvatarInterrupted`；参数使用公共 detail 类型。

第一阶段 React declarative `character` 只接受 Manifest URL 字符串，与 Web Component attribute 表面对齐。对象 Manifest 使用 Embed SDK/元素 imperative API，不在 B5 发明对象 diff/reinitialize 语义。

## 3. 允许修改

- `packages/avatar/src/react/**`
- `packages/avatar/test/react*.test.*`
- `packages/avatar/vite.config.ts` 仅在现有 react entry 构建必须修正时修改，不能增加入口
- React 测试必需的 devDependencies/package-lock；这是 AI-A 对 B5 的一次性预授权，只能增加 React 测试/类型依赖，React 必须保持 optional peer
- `docs/avatar/handoffs/B5-react-adapter.md`

禁止修改 core/renderers/audio/testing、package exports、peer dependency 范围、公共事件和 Web Component 语义。

## 4. 行为

- 首次 render 生成一个 `<pi-avatar>`，正确映射属性；false autoplay 必须表达为 Web Component 可识别的 `"false"`。
- props 更新只更新对应属性/监听回调，不重建元素或 Controller（character 变化按 B2 已定语义处理）。
- 移除可选 prop 时移除属性，不能留下旧值。
- 事件监听只注册一组；回调 prop 更新后调用最新函数，不重复派发。
- unmount 调用 destroy；React StrictMode mount/unmount/mount 不泄漏、不重复定义元素。
- ref 指向真实 `PiAvatarElement`，卸载后为 null。
- 不把 React 打进产物，不让 React 进入 root/core/web-component/testing。

## 5. 测试、验证与交接

覆盖首渲染、所有 props、prop 删除、状态更新、character 更新、六事件、callback 更新、ref 方法、unmount destroy、StrictMode、多实例和 bundle 边界。

运行完整 typecheck/test/build/pack/diff-check。创建 B5 handoff，提供 React 18+ 示例、类型表、bundle 证明和已知限制，明确“B6 未开始”，等待 AI-A Review。
