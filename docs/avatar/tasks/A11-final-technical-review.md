# A11 任务单：Visual MVP 最终发布候选 Review

状态：Blocked until B6、B7、B8 complete
执行者：AI-A（强模型/技术负责人）
任务性质：视觉组件发布候选审查；不审查 Agent 或语音能力。

## 1. 必须审查

1. production build、类型、公共入口和 package exports 正确。
2. root 导入无自动注册副作用；React 不进入基础 bundle；Rive 保持 lazy chunk。
3. `npm pack` 产物可被独立消费者 clean install 和 production build。
4. 真实角色、五状态、布局、resize、多实例、错误和 destroy/recreate 有浏览器证据。
5. 消费者不引用仓库 `src/**`、内部 factory 或 Testing 入口。
6. README 能指导已有前端项目完成安装和展示。
7. 依赖许可证、audit、包内容和体积无阻断项。
8. 文档明确 Agent、语音、嘴型未实现且不属于本次发布范围。

## 2. 必须运行

- clean install
- typecheck、unit test、build test
- B6 consumer clean install/build
- B7 Chromium Visual MVP E2E
- pack dry-run、audit、diff-check
- 从 tarball 手工完成一次 create/destroy/recreate

## 3. 输出

创建 `docs/avatar/handoffs/A11-final-review.md`，结论只能是：

- `Approved Visual MVP Release Candidate`
- `Changes Required`

真正执行 npm/private registry 发布仍需要用户确认版本号、registry 和发布权限。
