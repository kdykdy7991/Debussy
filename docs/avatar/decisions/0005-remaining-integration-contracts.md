# ADR-0005：剩余阶段集成契约

状态：Accepted  
日期：2026-08-10  
决策人：AI-A

## 背景

B4 需要一个明确的 Embed SDK 返回值，A6～A9 还需要明确生产组合层所有权。原计划只有任务摘要，若不先冻结，AI-B 可能新增 package export 或暴露内部 Controller，AI-A 也可能遗漏 Web Component 的生产工厂。

## 决策

### 1. Embed SDK 公共表面

`@skdy/avatar` 根入口兼容性新增：

```ts
export interface AvatarEmbedOptions extends AvatarConfig {
  target: string | HTMLElement;
}

export interface AvatarEmbedHandle {
  readonly element: PiAvatarElement;
  readonly controller: AvatarController;
  readonly ready: Promise<void>;
  destroy(): void;
}

export function createAvatar(options: AvatarEmbedOptions): AvatarEmbedHandle;
```

- `target` 字符串使用 `document.querySelector()`；无匹配或非法选择器抛出 `AvatarError("INVALID_CONFIG")`。
- `controller` 是新建 `<pi-avatar>` 元素暴露的 Controller 形状代理，不返回内部 `CoreAvatarController`。
- `ready` 对应本次初始化；失败时 reject，元素保留以便读取错误状态和显式销毁。
- `destroy()` 幂等，销毁 Controller 并移除 SDK 创建的元素；同一 target 随后可以重新创建。
- 多次 `createAvatar()` 默认创建独立实例，不隐式替换 target 中的已有实例。

### 2. 入口副作用

- 不新增 `@skdy/avatar/embed` package export。
- 导入 `@skdy/avatar` 不得自动注册 `<pi-avatar>`。
- `createAvatar()` 被调用时才执行带 `customElements.get()` 防护的注册。
- `@skdy/avatar/web-component` 仍保留导入即注册语义。

### 3. 生产组合层

A6-PREVIEW 先交付 renderer-only Visual Runtime 和默认 Controller 工厂，确保不等待语音即可看到角色；A9 在其上补齐最终音频组合：

```text
CoreAvatarController
  └─ Visual Runtime（A6-PREVIEW）
       ├─ Character Manifest loader（A6）
       ├─ RiveAvatarRenderer（A5，动态加载）
       └─ A9 最终扩展
            ├─ WebAudioPlayer（A7）
            └─ Audio analyser（A8）
```

- `setControllerFactory()` 继续作为测试/高级宿主覆盖点。
- 未显式覆盖时，Web Component 使用生产默认工厂。
- Visual/生产 Runtime、Renderer factory 和音频实现均为内部接口，不新增 package export。
- Rive SDK 必须动态/按需加载，基础入口静态依赖图不得包含 Rive runtime。

### 4. React 入口

`@skdy/avatar/react` 导出 `PiAvatar`、`PiAvatarProps`；`PiAvatar` 使用 `forwardRef<PiAvatarElement>`。React 是 optional peer，不能进入其他入口或被打进产物。

## 影响

- B4、B5 可以在不猜测公共 API 的情况下执行。
- A9 有明确责任交付真正可运行的生产 Controller，而不是只留下 Fake 注入点。
- 所有新增均为兼容性新增，不修改协议版本、事件、错误码或 Manifest schema。
