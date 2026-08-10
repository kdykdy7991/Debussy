# ADR-0002：数字人 Renderer 内部边界

状态：Accepted  
日期：2026-08-08  
决策人：AI-A（A2）

## 背景

Core 需要驱动数字人画面，但不能依赖 Rive SDK，也不能把 Rive State Machine Input 等实现类型暴露给 Web Component、React 或未来 Agent Adapter。真实 Rive renderer 尚未实现，嵌入层仍应能够使用 FakeRenderer 并行开发。

## 决策

1. `AvatarRenderer` 是 `packages/avatar/src/renderers` 下的内部接口，不加入 npm package exports。
2. renderer 接收已解析、已校验的 Character Manifest；下载和校验 manifest 属于 A6。
3. renderer 初始化时接收一个 `HTMLElement` 容器，不拥有或删除该宿主元素，只管理自己创建的 Canvas/runtime 资源。
4. renderer 接收 `AbortSignal`，初始化被替换或 Controller 销毁时必须尽快取消。
5. renderer 只接收标准 `AvatarState` 和归一化 `audioLevel`，不知道 Agent/Pi 事件。
6. resize 使用 CSS 像素和 `devicePixelRatio`，避免不同实现自行读取全局 window 并导致测试困难。
7. renderer 不派发产品事件。`avatar-ready`、状态变化和错误等公共事件由 Core Controller 统一产生。
8. `destroy()` 必须幂等，释放 Canvas、WASM/runtime、动画帧和内部监听器，但不得销毁宿主容器。
9. renderer 通过 `AvatarRendererFactory` 创建，具体实现的选择由后续组合层完成。

## 接口

```ts
interface AvatarRenderer {
  initialize(input: AvatarRendererInitialization): Promise<void>;
  setState(state: AvatarState): void;
  setAudioLevel(level: number): void;
  resize(viewport: AvatarViewport): void;
  destroy(): void;
}
```

该接口不包含 `show()`、`hide()`：显示与隐藏属于宿主容器/嵌入层职责。它也不包含音频播放：renderer 只消费已经归一化的 `audioLevel`。

## 影响

- A5 可以实现 Rive renderer，而不修改 Core 或公共 API。
- A3 可以提供 FakeRenderer；AI-B 可在没有 Rive/WASM 的情况下开发 Web Component。
- 更换 Live2D、Three.js 等实现时需要扩展 manifest 的 renderer 联合类型，但不需要更改 Controller 命令。
- renderer 接口目前不是消费者 API；如果未来开放第三方 renderer，需要单独 ADR 和版本策略。
