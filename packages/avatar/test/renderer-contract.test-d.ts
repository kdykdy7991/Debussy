import type {
  AvatarRenderer,
  AvatarRendererFactory,
  AvatarRendererInitialization,
  AvatarViewport,
} from "../src/renderers/index.js";

class FakeRenderer implements AvatarRenderer {
  readonly calls: string[] = [];

  async initialize(input: AvatarRendererInitialization): Promise<void> {
    this.calls.push(`initialize:${input.character.id}:${input.initialState}`);
  }

  setState(state: "idle" | "listening" | "thinking" | "speaking" | "error"): void {
    this.calls.push(`state:${state}`);
  }

  setAudioLevel(level: number): void {
    this.calls.push(`audio:${level}`);
  }

  resize(viewport: AvatarViewport): void {
    this.calls.push(`resize:${viewport.width}x${viewport.height}@${viewport.devicePixelRatio}`);
  }

  destroy(): void {
    this.calls.push("destroy");
  }
}

const factory = {
  type: "rive",
  create: () => new FakeRenderer(),
} satisfies AvatarRendererFactory;

const renderer: AvatarRenderer = factory.create();
renderer.setState("thinking");
renderer.setAudioLevel(0.5);
renderer.resize({ width: 320, height: 480, devicePixelRatio: 2 });
renderer.destroy();

// @ts-expect-error Renderer state remains constrained to the public state contract.
renderer.setState("tool-calling");

// @ts-expect-error Viewport must explicitly include physical-pixel scaling.
renderer.resize({ width: 320, height: 480 });
