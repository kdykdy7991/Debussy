# Avatar

数字人能力包（`@skdy/avatar`）第一阶段。A0～A6、B0～B4 已完成；当前优先执行 A6-PREVIEW，让真实数字人先可见，B5 可并行。

## Embed 使用（task B4）

`createAvatar()` 由根入口导出，把一个 `<pi-avatar>` 挂到指定目标并返回可用的实例。导入根入口本身不会注册自定义元素，只有调用 `createAvatar()` 时才按需注册。

```js
import { createAvatar } from "@skdy/avatar";

const avatar = createAvatar({
  target: "#app",          // 或直接传 HTMLElement
  character: "/characters/demo/manifest.json",
  mode: "floating",
  position: "bottom-right",
  width: 320,
  height: 480,
});

await avatar.ready;        // 初始化完成；失败则 reject，元素保留以便查错
avatar.controller.setState("thinking");
avatar.controller.addEventListener("avatar-ready", () => {});
avatar.destroy();          // 幂等；销毁后可在同一 target 重新创建
```

- `character` 传 URL 字符串会映射为元素属性；传 `CharacterManifest` 对象则通过 `initialize()` 传递，不会序列化进 DOM。
- `target` 字符串用 `document.querySelector()` 解析；无匹配或非法时抛 `AvatarError("INVALID_CONFIG")`。
- `avatar.controller` 是元素自身的公开 Controller 接口（方法与六个事件原样可用），不暴露内部实现类。
- `destroy()` 幂等，并安全移除 SDK 创建的元素；宿主已自行移除元素时也安全。同一 target 可同时存在多个独立实例。

## React 使用（task B5）

`PiAvatar` 是 `<pi-avatar>` 的薄 React 适配器（`@skdy/avatar/react`），React 保持可选 peer 依赖，不会被打包进产物。序列化 props 映射为元素属性，事件回调用六种标准事件透传，ref 指向真实 `PiAvatarElement` 以便调用命令式 Controller 方法。

```jsx
import { PiAvatar } from "@skdy/avatar/react";

function Demo() {
  return (
    <PiAvatar
      character="/characters/demo/manifest.json"
      mode="floating"
      position="bottom-right"
      width={320}
      height="50vh"
      background="#101010"
      onAvatarStateChange={(d) => console.log(d.current)}
      onAvatarReady={(d) => console.log("ready", d.manifestUrl)}
    />
  );
}
```

- 第一阶段 `character` 只接受 manifest URL 字符串（与元素属性一致）；对象 manifest 请走 `createAvatar()` / 命令式元素 API。
- `onAvatar*` 回调用原生事件，重渲染时始终调用最新回调，不会重复注册监听。
- unmount 自动 `destroy()` 对应 Controller，ref 置为 `null`。

## 布局使用说明（task B3）

`<pi-avatar>` 的布局样式位于 Shadow DOM 内的单一 `<style data-avatar-layout>`，不注入宿主文档，也不会被宿主 CSS 影响或污染宿主页面。

### 展示模式

- **inline（默认）**：`mode` 缺失或非法时回退为 inline，元素参与正常文档流，不使用固定定位。默认尺寸宽 `320px`、高 `480px`。
- **floating**：`mode="floating"` 时元素相对浏览器视口固定悬浮，默认右下角；`position="bottom-left"` 切换左下角，`position` 缺失或非法回退为 `bottom-right`。偏移已考虑 `env(safe-area-inset-left/right/bottom)`。

### 尺寸与背景

- `width` / `height` / `background` HTML 属性以内联样式生效，优先级高于 CSS 变量；纯数字会被归一化为 CSS 像素长度（`320` → `320px`）。
- 移除这些属性会清除对应内联样式，恢复到默认值。

### 可配置的 CSS Custom Properties

宿主可直接在 `<pi-avatar>` 元素上覆盖以下变量（默认值冻结）：

```css
--pi-avatar-width: 320px;
--pi-avatar-height: 480px;
--pi-avatar-z-index: 1000;
--pi-avatar-offset-x: 16px;
--pi-avatar-offset-y: 16px;
```

`width` / `height` HTML 属性的内联样式优先于 CSS 变量。

### 移动端约束

- inline 的基础上限为 `100vw`；floating 会进一步扣除两侧 offset 与 safe-area，避免窄视口溢出。
- stage 最大高度不超过动态视口高度，优先 `100dvh`，并提供 `100vh` 回退。
- 第一阶段不通过 JavaScript 监听 resize；响应式约束由 CSS 完成。
