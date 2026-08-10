# B7 任务单：Visual MVP 浏览器嵌入验收

状态：Blocked until B6 approved
执行者：AI-B（经济模型/实现者）
前置：B6 独立消费者安装与构建通过

## 1. 目标

使用独立消费者的 production build，证明正式 Avatar 包在真实浏览器中能稳定展示和销毁。只验收视觉能力，不涉及 Agent、语音、嘴型、麦克风或音频权限。

## 2. 允许修改

- `packages/avatar/test/e2e/**`
- Playwright 配置和独立消费者测试 server
- `packages/avatar/examples/consumer/**` 中仅为可测性增加的内部标识
- `docs/avatar/handoffs/B7-visual-acceptance.md`

不得新增生产公共 API，不得引用 `src/**`，不得用 Fake 替代正常 production 路径。

## 3. 必须覆盖

- tarball 安装后的消费者 production build 能加载真实 Rive 角色并收到 ready。
- `idle/listening/thinking/speaking/error` 五状态可切换。
- inline/floating、bottom-left/bottom-right 和 375px 视口约束正确。
- 激进宿主 CSS 不污染 Shadow DOM 内角色。
- resize/DPR、Hide/Show、Destroy/Recreate 正常。
- 多实例互不影响。
- Manifest/Rive 网络失败显示标准 error，页面无 unhandled rejection。
- B5 Follow-up：非 character prop 更新不得重建 Controller；character 真正变化时才重建。

## 4. 证据和验证

- Chromium 为当前必测浏览器。
- 使用 locator/event/condition wait，不使用固定 sleep 判定成功。
- 保存桌面和 375px 截图；失败保存 screenshot/trace。
- 运行 Avatar 完整门禁、消费者 clean install/build 和 Playwright 全量。

创建 `docs/avatar/handoffs/B7-visual-acceptance.md` 后等待 AI-A Review，不自动进入其他任务。
