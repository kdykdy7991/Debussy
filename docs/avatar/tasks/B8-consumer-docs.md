# B8 任务单：消费者接入文档

状态：Blocked until B6、A9 approved  
执行者：AI-B（经济模型/实现者）  
前置：B6、A9；可与 B7 并行。最终文档必须在语音完成后写，避免记录临时预览行为。

## 1. 目标

让未参与本项目的前端开发者在 15 分钟内把数字人嵌入空白 HTML 页面，并能判断常见错误、正确销毁实例、为未来 Agent Adapter 保留清晰边界。

## 2. 允许修改

- `packages/avatar/README.md`
- `docs/avatar/consumer/**`
- 示例 README/代码片段中与真实 API 不一致的文档性修正
- `docs/avatar/handoffs/B8-consumer-docs.md`

不得修改实现来迁就文档；发现 API/行为不一致时提交给对应 Owner。

## 3. 文档必须包含

- 支持范围与第一阶段明确不包含的 Agent/TTS/ASR 能力。
- npm/本地 ESM/CDN 完整 dist 三种接入方式；说明共享 chunk 必须整体部署。
- `<pi-avatar>`、`createAvatar()`、React `PiAvatar`、Vue Custom Element 四种快速开始。
- 全部属性、方法、六事件、错误码、speech end reason 和协议版本。
- `ready`、初始化失败、重试、stop/interrupt、destroy/recreate 的正确代码。
- inline/floating、五个 CSS Custom Properties、375px 和 safe-area 说明。
- Manifest 文件格式、asset 相对 URL、CORS/MIME/CSP/WASM/音频用户手势要求。
- React ref/unmount、Vue custom element compiler 配置。
- 多实例、资源释放、版本升级和常见问题排查。
- “后续 Agent 对接”只说明 Adapter 如何映射现有命令/事件，不发明 Pi 协议。

所有示例必须从公共入口导入并与当前类型检查结果一致，不得出现 `src` 深路径、内部 factory 或 Fake。

## 4. 15 分钟接入验证

使用一个不引用仓库源码的干净 fixture，按文档从零完成 Vanilla 接入。记录：开始/结束时间、执行命令、浏览器、成功 ready/状态切换/销毁证据、遇到的文档歧义。超过 15 分钟必须修正文档并重测。

## 5. 验证与交接

- 对 README 代码片段做可运行或类型检查验证。
- 运行链接检查、Avatar 完整门禁和文档引用路径检查。
- 对照 public `.d.ts` 逐项核对 API 表。

创建 B8 handoff，包含文档清单、15 分钟记录、验证结果、已知限制和待 A11 检查项。完成后等待 AI-A Review。
