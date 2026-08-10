# A11 任务单：最终技术 Review

状态：Blocked until A10、B7、B8 complete  
执行者：AI-A（强模型/技术负责人）  
任务性质：发布候选审查；默认只读，发现缺陷先归属任务，不做无边界重构。

## 1. 输入

- A0～A10、B0～B8 全部 handoff
- B7 Playwright 报告与证据
- B8 接入文档和 15 分钟接入记录
- 开发计划第 11～15 节

## 2. 必须审查

1. 公共 API、事件、错误码和协议版本与 ADR 一致，无意外深路径导出。
2. root/core 导入无注册副作用；React/Rive 不进入不应进入的 chunk。
3. 完整 dist 可 CDN 部署，资源不内联，干净页面可运行。
4. Manifest/Rive/audio/analyser/controller/component/embed/react 的错误和销毁链闭合。
5. 并发初始化、播放、打断、重挂载、多实例无竞态回写。
6. AC-01～AC-12 与 Definition of Done 全有证据。
7. README、示例、类型声明与真实 API 一致，未把 Agent runtime/TTS 写成已实现。
8. 依赖许可证、安全审计、包内容和体积无阻断问题。

## 3. 必须运行

干净安装后运行 typecheck、全部单元/构建测试、Playwright Chromium、pack dry-run、audit、diff-check；检查 tarball 和入口静态依赖图。手工执行一次 Vanilla 快速接入及 create/destroy/speak/interrupt 流程。

## 4. 输出

创建 `docs/avatar/handoffs/A11-final-review.md`：

- 结论只能是 `Approved Release Candidate` 或 `Changes Required`。
- AC/DoD 逐项证据表。
- 公共 API、bundle、依赖和资源生命周期审计。
- 测试命令、版本、浏览器和结果。
- 阻断项的 Owner、复现、验收条件，以及非阻断限制。
- 第二阶段建议与第一阶段完成条件分开。

测试通过但缺少真实资产、浏览器证据或接入文档时不得批准。
