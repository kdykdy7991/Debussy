# B7 任务单：Playwright 嵌入验收

状态：Blocked until B6、A9、A10 approved  
执行者：AI-B（经济模型/实现者）  
前置：B6 示例、A9 生产组合、A10 场景设计

## 1. 必须阅读

- `docs/avatar/e2e/PHASE-1-SCENARIOS.md`
- A9、A10、B6 handoff
- 开发计划 AC-01～AC-12 与 Definition of Done

## 2. 允许修改

- `packages/avatar/test/e2e/**`
- Playwright config、e2e fixture/server
- `packages/avatar/examples/**` 中仅为可测性必需且不改变消费者 API 的标识
- examples/e2e 私有 package 的 Playwright devDependency 和 scripts
- `docs/avatar/handoffs/B7-playwright-acceptance.md`

禁止为测试新增生产公共 API、改变事件时序、绕过真实 production build 或把 Fake 当作正常路径。

## 3. 浏览器与证据

- 第一阶段必须覆盖 Chromium；WebKit/Firefox 记录为后续扩展，不阻断本任务。
- 正常路径加载 production `dist` 和真实 Demo Manifest/Rive/音频。
- 网络错误通过本地 server route/fixture 制造。
- 失败默认保留 screenshot、video、trace；关键视觉用例即使通过也保存基准截图。
- 使用事件/locator/route 等条件等待，不以固定 sleep 作为通过依据。

## 4. 必须覆盖

实现 A10 的全部 P0/P1 场景，并确保 AC-01～AC-12 无遗漏，重点包括：

- 干净 Vanilla ESM 接入与 ready。
- 激进宿主 CSS 下 Shadow DOM 隔离。
- 五状态、真实 speak/嘴型/结束归零、stop、interrupt、连续 speak。
- manifest/audio/Rive 错误与 autoplay blocked，无 unhandled rejection。
- DOM 重连、SDK 重复创建、React StrictMode、Vue props/attribute 更新。
- 多实例隔离。
- 375px floating 左右角和 safe-area/offset 约束。
- resize/DPR 和销毁后的 Canvas、RAF、observer、audio 资源计数。

## 5. 测试工程要求

- 测试可串行重现高风险时序；互不共享残留页面状态。
- fixture 音频短小、许可证明确；不得依赖公网可用性。
- 对浏览器无法直接观察的资源使用 A10 批准的 test-only instrumentation，不能暴露到 package public API。
- 至少连续运行三次关键竞态集合，证明无 flake；失败必须保留 seed/trace。

## 6. 验证与交接

运行 Avatar 完整门禁、examples build、Playwright Chromium 全量及关键场景重复运行。创建 B7 handoff，包含 AC→测试映射、浏览器版本、命令、结果、证据路径、flake 记录、未覆盖浏览器和契约变更请求。完成后等待 AI-A Review。
