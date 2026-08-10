# B8 任务单：Visual MVP 消费者与发布文档

状态：Blocked until B6 approved；可与 B7 并行
执行者：AI-B（经济模型/实现者）
前置：B6

## 1. 目标

让未参与项目的前端开发者能把发布后的 `@skdy/avatar` 包安装到已有项目，并在 15 分钟内看到数字人。文档以通用 `createAvatar()` / Web Component 为主，不要求读者采用 React、Vue 或其他框架。

## 2. 允许修改

- `packages/avatar/README.md`
- `docs/avatar/consumer/**`
- `packages/avatar/examples/consumer/README.md`
- `docs/avatar/handoffs/B8-consumer-docs.md`

## 3. 必须包含

- npm/private registry 发布后的安装方式，以及当前 tarball 本地验证方式。
- `createAvatar()` 快速开始；`<pi-avatar>` 作为可选方式。
- character、state、layout、ready/error、destroy/recreate 的视觉使用说明。
- Manifest、Rive 资产、CORS、CSP、WASM CDN 和网络失败排查。
- 包含哪些 dist/chunk，部署时不能只复制单个入口文件。
- 明确声明当前不包含 Agent、TTS、ASR、音频播放和嘴型。
- React 适配器只放在“可选”章节；不编写 Vue/Angular/Svelte 专用接入实现。

## 4. 验证

- 使用 B6 的独立消费者按文档从零 clean install/build。
- 记录 15 分钟接入过程和歧义修正。
- README 示例必须只使用公开入口并与 `.d.ts` 一致。

完成后创建 `docs/avatar/handoffs/B8-consumer-docs.md`，等待 AI-A Review。
