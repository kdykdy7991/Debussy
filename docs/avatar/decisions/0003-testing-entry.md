# ADR-0003：独立测试夹具入口

状态：Accepted  
日期：2026-08-08  
决策人：AI-A（A3）

## 背景

AI-B 的 Web Component 工作依赖 Controller，但真实 Rive renderer、manifest loader 和 Web Audio 尚未实现。直接导入 `src/core` 私有路径会耦合目录结构，复制 Fake 则会造成契约漂移。

## 决策

1. 以兼容性新增方式提供 `@skdy/avatar/testing` 子路径，不修改任何既有入口。
2. testing 入口导出 FakeRenderer、FakeAudio、FakeAvatarRuntime 和 `createAvatarTestHarness()`。
3. testing 入口无自动注册和浏览器全局副作用，不加入 package `sideEffects`。
4. testing 入口用于本仓库测试、示例和开发环境，不承诺作为最终业务消费者 API。
5. AI-B 不得绕过该入口直接导入 Core Controller、Runtime Port 或 renderer 私有文件。
6. FakeAudio 由测试显式结束或失败，不依赖网络、真实音频设备和计时器，从而保证测试确定性。

## 影响

- B2 可以立即使用真实 Controller 行为开发组件代理和生命周期测试。
- 测试入口增加了构建产物，但不会进入消费者的基础 bundle，且可以被 tree-shaking 隔离。
- 若未来拆分 npm 包，testing 入口可以迁移为独立测试包，不影响业务公共接口。
