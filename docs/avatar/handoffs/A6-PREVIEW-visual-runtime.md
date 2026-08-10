# A6-PREVIEW 交接单：真实数字人视觉预览

状态：Complete / Ready for User Visual Acceptance  
日期：2026-08-10  
执行者：AI-A

## 1. 交付结果

- `<pi-avatar>` 未配置测试工厂时会使用生产 Visual Runtime。
- Visual Runtime 加载 A6 Manifest，动态创建 A5 Rive Renderer，并处理五态、resize/DPR、show/hide、abort、destroy 和多实例。
- `startSpeech()` 明确以 `AUDIO_PLAYBACK_FAILED` 拒绝，未伪装语音成功。
- 提供真实 Rive 角色 Manifest 和只消费正式 `dist` 构建的预览页。
- 浏览器已验证桌面、375px floating、五态、Hide/Show、Destroy/Recreate。
- 未实现 Agent 通信、TTS、音频播放或嘴型采样；未启动 A7。

## 2. 主要文件

- `packages/avatar/src/runtime/visual-avatar-runtime.ts`
- `packages/avatar/src/runtime/index.ts`
- `packages/avatar/src/web-component/pi-avatar.ts`
- `packages/avatar/assets/characters/demo/manifest.json`
- `packages/avatar/assets/characters/demo/SOURCE.md`
- `packages/avatar/dev/preview/index.html`
- `packages/avatar/dev/preview/preview.js`
- `packages/avatar/dev/preview/preview.css`
- `packages/avatar/test/visual-avatar-runtime.test.mjs`
- `packages/avatar/test/preview-contract.test.mjs`
- `packages/avatar/test/vite/build-esm.test.mjs`

## 3. 预览启动

从 `packages/avatar` 执行：

```bash
npm run build:esm
npx vite --host 127.0.0.1 --port 4173
```

打开：`http://127.0.0.1:4173/dev/preview/`

预览页只导入 `/dist/web-component/index.js`，不从 `src` 深路径运行。

## 4. Demo 资产

- 文件：Rive 官方 `neostreamv2.riv`
- 上游：`rive-app/rive-wasm`
- 固定 revision：`d592fe24f7ba94679203984e98b65489f6acbc97`
- 许可证：MIT
- 默认画板：`Character_animation`
- 状态机：`State Machine 1`
- 五态映射：
  - `idle → numFlame`
  - `listening → Duck`
  - `thinking → Jump`
  - `speaking → Chest`
  - `error → Back`

Manifest 使用 revision-pinned raw URL；这保证上游默认分支变化不会静默改变预览内容，但浏览器首次加载仍需能访问 GitHub Raw 和 Rive WASM CDN。

## 5. 验证证据

已通过：

- A6-PREVIEW 源码隔离 TypeScript 编译。
- A6-PREVIEW + Web Component 专项测试：`28/28`。
- Vite production ESM 构建。
- Vite 构建契约：`7/7`。
- Rive SDK 仅出现在 lazy chunk：`rive-renderer-*.js` 约 `263.62 kB`（gzip `61.30 kB`）；root/core/web-component 静态可达基础图不含 Rive Runtime。
- 浏览器五态事件顺序：`idle → listening → thinking → speaking → error`。
- 浏览器 Hide/Show、Destroy/Recreate；重建后第二次收到 `avatar-ready`。
- 浏览器 console/error：无错误、无 unhandled rejection。

截图：

- [Desktop](./A6-PREVIEW-desktop.png)
- [375px floating](./A6-PREVIEW-mobile-375.png)

## 6. 并行 B5 对全仓门禁的影响

A6-PREVIEW 自身验证已通过，但本次交接时 B5 仍在共享工作树中开发。以下全仓命令被 B5 尚未完成的文件阻断，不能将其误记为 A6-PREVIEW 失败：

- `npm run typecheck`：`src/react/index.ts` 的 JSX 配置和 default export 未收口。
- `npm test` / `npm run test:build`：会先执行同一 TypeScript 构建；B5 当前新增的 `react-adapter.test.mjs` 还包含 TypeScript 语法。

B5 完成后必须从干净的 `npm` scripts 重新执行：

```bash
npm run typecheck
npm test
npm run test:build
npm pack --dry-run
npm audit --audit-level=high
```

## 7. 后续入口与停止点

- B5 完成且用户确认视觉后，B6 可直接使用默认 `<pi-avatar>` / `createAvatar()` 展示真实角色。
- 后续 Agent Adapter 只调用现有 Controller，不进入本 Runtime。
- A9 在此 Runtime 上补 `startSpeech()` 与 audioLevel 组合，不重写视觉链路。
- 当前停止：等待用户视觉确认，不自动启动 A7。
