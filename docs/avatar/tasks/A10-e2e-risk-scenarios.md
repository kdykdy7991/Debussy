# A10 任务单：高风险 E2E 场景设计

状态：Blocked until A9 approved  
执行者：AI-A（强模型/技术负责人）  
任务性质：测试设计和技术验收输入，不实现 B7 Playwright 测试。

## 1. 允许修改

- `docs/avatar/e2e/**`
- `docs/avatar/handoffs/A10-e2e-scenarios.md`
- 仅用于证明场景可执行的 fixture 说明或伪代码

不得借 A10 重构实现或新增公共测试 API。

## 2. 必须交付

创建 `docs/avatar/e2e/PHASE-1-SCENARIOS.md`。每个场景包含：ID、对应 AC、fixture、步骤、可自动观察结果、等待条件、清理断言、失败证据和 Owner。

至少设计：

- 初始化中切换 character，最新请求胜出。
- 连续两次 speak，旧语音迟到事件不回写。
- play 前/后 stop 与 interrupt 的事件顺序。
- autoplay blocked、audio 404/CORS、manifest 404/非法、Rive load error。
- DOM 移除再插入、React StrictMode 重挂载、重复 SDK create/destroy。
- 多实例状态和音频互不干扰。
- 375px floating 左右角、安全区、宿主激进 CSS。
- resize/DPR 变化，无重复 Canvas/observer。
- 初始化、播放和销毁交错时无 unhandled rejection。
- RAF、监听器、ResizeObserver、AudioContext、Canvas 的资源计数归零。

## 3. 可执行性规则

- 使用事件、DOM、route 和 fixture 计数器等稳定信号，不用固定 sleep 判定成功。
- 不要求精确堆内存数；泄漏使用创建/销毁计数和持续回调检测。
- 正常路径使用真实 production build；网络错误由本地 server route 控制。
- 每个场景注明是否需要真实 Rive/音频。
- 给出 B7 Chromium 最小矩阵和失败时 screenshot/video/trace 要求。

## 4. 验收与交接

对 AC-01～AC-12 建立双向追踪表，不得有未覆盖 AC。handoff 列出 P0/P1 场景、B7 实现顺序、允许的 test-only instrumentation 和禁止修改的生产契约。完成后等待 Review。

运行文档链接检查（如仓库无脚本则逐项验证本任务新增相对链接）和 `git diff --check`；不得声称未执行的 Playwright 场景已通过。
