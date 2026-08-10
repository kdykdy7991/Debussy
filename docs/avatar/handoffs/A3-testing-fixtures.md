# A3 交接：Avatar 测试夹具

状态：Ready for B2  
Owner：AI-A  
入口：`@skdy/avatar/testing`

## 提供的能力

- `FakeRenderer`：记录 initialize、state、audioLevel、resize 和 destroy 调用。
- `FakeAudio`：手动完成、停止、打断或失败一段语音，不访问网络和真实音频设备。
- `FakeAvatarRuntime`：把 FakeRenderer/FakeAudio 组合为 Core Controller 所需的内部 runtime。
- `createAvatarTestHarness()`：一次获得 controller、runtime、renderer 和 audio。

## B2 最小用法

```ts
import { createAvatarTestHarness } from "@skdy/avatar/testing";

const container = shadowRoot.querySelector<HTMLElement>("[data-avatar-stage]");
if (!container) throw new Error("Missing avatar stage");

const harness = createAvatarTestHarness({ container });

await harness.controller.initialize({
  character: "/characters/demo/manifest.json",
});

harness.controller.setState("thinking");

const speaking = harness.controller.speak({ audioUrl: "/answer.wav" });
await Promise.resolve();
harness.audio.finishSpeech("completed");
await speaking;
```

## 组件测试断言

```ts
expect(harness.renderer.calls).toContainEqual({
  method: "setState",
  state: "thinking",
});

expect(harness.runtime.visible).toBe(false);
expect(harness.renderer.destroyed).toBe(true);
expect(harness.audio.destroyed).toBe(true);
```

## 使用限制

1. 该入口只用于仓库测试、示例和开发环境，不是最终消费者 API。
2. Fake 不加载 manifest URL。传字符串时会合成测试 manifest；需要固定角色 ID 时传 `fallbackCharacter`。
3. Fake 不验证 Rive input mapping，也不模拟 Canvas/WASM。
4. FakeAudio 默认不会自动结束；测试必须调用 `finishSpeech()`、`failSpeech()`、Controller 的 `stopSpeaking()` 或 `interrupt()`。
5. B2 不得直接导入 `src/core/controller.ts`、`src/core/runtime.ts` 或 renderer 私有路径。
6. Web Component 的生产 Controller 组合入口不属于 B2；在真实组合层完成前，B2 通过依赖注入或测试工厂使用该 harness。

## 验证依据

- `test/testing-contract.test-d.ts`
- `test/testing-fixtures.test.mjs`
- `test/controller.test.mjs`
