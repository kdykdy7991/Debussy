# A9 任务单：语音与视觉 Runtime 最终组合

状态：Deferred until A6-PREVIEW、A7、A8 approved  
执行者：AI-A（强模型/技术负责人）  
前置：A6-PREVIEW、A7、A8  
关键责任：复用已经可见的视觉 Runtime，最后补齐真实语音、嘴型和完整生产生命周期；不得重做预览链路。

## 1. 必须阅读

- `docs/avatar/decisions/0005-remaining-integration-contracts.md`
- A5、A6、A6-PREVIEW、A7、A8 handoff
- `packages/avatar/src/core/runtime.ts`
- `packages/avatar/src/web-component/pi-avatar.ts`
- `packages/avatar/src/renderers/rive/**`

## 2. 允许修改

- `packages/avatar/src/runtime/**` 或等价内部组合目录
- `src/renderers/**`、`src/audio/**` 的必要集成修正
- `src/web-component/**` 中默认工厂接入（保留测试覆盖点）
- `packages/avatar/assets/characters/demo/**`
- A9 单元、集成和构建测试
- A9 ADR 与 `docs/avatar/handoffs/A9-demo-character-integration.md`

公共状态、事件、错误码、Manifest schema、package exports 不得修改。

## 3. 最终生产 Runtime

扩展 A6-PREVIEW 已交付的 Visual Runtime，完整满足 `AvatarRuntimePort`：

- initialize、renderer、resize、默认 factory 和 Demo 资产直接复用 A6-PREVIEW；只做必要集成修正。
- startSpeech：使用 A7/A8，采样回调驱动当前 renderer `setAudioLevel()`。
- setState/setAudioLevel：转发到当前 renderer。
- show/hide：控制当前组件可见性，不删除宿主 DOM。
- resize：使用 `ResizeObserver` 读取 stage CSS 像素并传递 DPR；初始化立即 resize；销毁移除 observer。
- destroy：abort pending manifest/renderer/audio，幂等释放全部资源；迟到回调不得写入已销毁实例。

### 默认 Controller 工厂回归

- 未调用 `setControllerFactory()` 时，`<pi-avatar>` 继续使用 A6-PREVIEW 已交付的生产默认工厂。
- 测试显式 factory 仍优先，并可恢复默认行为。
- `@rive-app/canvas` 必须动态/按需加载，不得静态进入 root/core/web-component 基础 chunk。
- 导入根入口仍不得自动注册 Custom Element。

## 4. Demo Character 回归

- 提供可部署 manifest，包含五种状态和 `audioLevel` 六个互不重复映射。
- asset URL 使用可部署相对路径，构建不得把 `.riv` 内联为 data URI。
- 用真实 `.riv` 或经批准的稳定资源做 Chromium 冒烟，核对 State Machine/Input 名。
- 若没有获准使用的 `.riv`，不得伪造二进制；完成可继续部分后把缺少资产标为阻塞并请求资源。

## 5. 测试与验收

覆盖生产 Runtime 初始化、URL/object manifest、状态/音量转发、resize、音频结束、快速重初始化、初始化中 destroy、多实例隔离、默认/覆盖 factory、Rive 动态加载边界。

浏览器冒烟必须证明：角色可见；五种状态可触发；播放时 audioLevel 非零；结束归零；销毁后 Canvas、RAF、observer、audio 节点停止。

运行完整 typecheck/test/build/pack/diff-check，并记录截图或录屏。

## 6. 验证与交接

创建 A9 handoff，给 B6 提供 demo manifest URL/启动方式，给 A10 提供生命周期观察点，明确 Rive 资产来源/许可证和限制。等待 Review，不启动 A10。
