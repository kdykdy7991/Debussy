# B4 任务单：`createAvatar()` Embed SDK

状态：Complete（AI-A 二次 Review 通过，2026-08-10）  
执行者：AI-B（经济模型/实现者）  
前置：B3 已通过 AI-A 二次 Review  
任务边界：实现框架无关的 JS 挂载层；使用 Fake 验收，不等待 A9 生产 Runtime。

## 1. 开始前必须阅读

1. `docs/avatar/PHASE-1-DEVELOPMENT-PLAN.md`
2. `docs/avatar/decisions/0005-remaining-integration-contracts.md`
3. `docs/avatar/handoffs/B0-contract-usage-checklist.md`
4. `docs/avatar/handoffs/B3-handoff.md`
5. `docs/avatar/handoffs/A4-build-approval.md`
6. `packages/avatar/src/web-component/pi-avatar.ts`

## 2. 允许修改

- `packages/avatar/src/embed/**`
- `packages/avatar/src/index.ts` 仅用于导出 ADR-0005 已批准的 `createAvatar`、`AvatarEmbedOptions`、`AvatarEmbedHandle`
- `packages/avatar/test/embed*.test.mjs`
- `packages/avatar/test/public-contract.test-d.ts`
- `packages/avatar/test/package-contract.test.mjs` 和构建测试中与根入口新增导出直接相关的断言
- `docs/avatar/handoffs/B4-embed-sdk.md`
- `packages/avatar/README.md` 的最小 Embed 使用片段

## 3. 禁止修改

- core/renderers/audio/testing 实现
- Web Component 已通过 Review 的生命周期语义
- package exports、sideEffects、peerDependencies、files
- Vite entries
- 公共状态、事件、错误码、Manifest schema
- 新增 `./embed` 子路径或导入即注册的根入口副作用

## 4. 必须实现的公共契约

严格实现 ADR-0005：

```ts
interface AvatarEmbedOptions extends AvatarConfig {
  target: string | HTMLElement;
}

interface AvatarEmbedHandle {
  readonly element: PiAvatarElement;
  readonly controller: AvatarController;
  readonly ready: Promise<void>;
  destroy(): void;
}

function createAvatar(options: AvatarEmbedOptions): AvatarEmbedHandle;
```

不得重命名、加重载或额外暴露内部 Controller。

## 5. 行为清单

- 字符串 target 用 `document.querySelector()`；非法/找不到/非 HTMLElement 抛 `INVALID_CONFIG`。
- HTMLElement target 直接使用；不清空、不替换已有子节点。
- 调用时按需执行 guarded Custom Element 注册；仅导入根入口不得注册。
- 创建唯一 `<pi-avatar>`，把 mode/position/width/height/background/autoplay/字符串 character 映射为属性。
- `CharacterManifest` 对象不序列化进 attribute，必须通过 `initialize(options)` 传递。
- 元素挂载后得到本次 `ready` Promise；初始化失败保持 reject，不静默 catch，不自动移除元素。
- `controller` 使用元素公开代理面；方法和六个事件语义不包装、不改名。
- handle destroy 幂等：调用元素 destroy 并移除 SDK 创建的元素；元素已被宿主移动/移除时也安全。
- 同 target 可同时存在独立实例；销毁后可重复创建；一个 handle 不影响另一个。

## 6. 必须测试

至少覆盖 selector/HTMLElement target、非法 target、所有属性、对象 character、不破坏既有 DOM、ready resolve/reject、controller 方法和事件、重复 destroy、宿主先移除、销毁后重建、多实例隔离、根入口导入无注册副作用、调用时重复注册安全。

使用 `@skdy/avatar/testing` 和 `setControllerFactory()`，不得深路径创建 Core Controller。

## 7. 验证、验收与交接

运行 typecheck、完整 test、test:build、pack dry-run、diff-check。确认 React/Rive 未进入 root 基础 bundle，媒体未内联。

创建 B4 handoff，列出 API、挂载/销毁语义、测试、构建影响、已知限制，并明确“B5 未开始”。等待 AI-A Review。
