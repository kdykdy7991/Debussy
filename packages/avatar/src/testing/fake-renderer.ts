import { AvatarError } from "../core/errors.js";
import type { AvatarState } from "../core/types.js";
import type {
  AvatarRenderer,
  AvatarRendererInitialization,
  AvatarViewport,
} from "../renderers/types.js";

export type FakeRendererCall =
  | { method: "initialize"; input: AvatarRendererInitialization }
  | { method: "setState"; state: AvatarState }
  | { method: "setAudioLevel"; level: number }
  | { method: "resize"; viewport: AvatarViewport }
  | { method: "destroy" };

export class FakeRenderer implements AvatarRenderer {
  readonly calls: FakeRendererCall[] = [];
  initialized = false;
  destroyed = false;

  async initialize(input: AvatarRendererInitialization): Promise<void> {
    if (input.signal.aborted) {
      throw new DOMException("Renderer initialization was aborted", "AbortError");
    }
    if (this.destroyed) {
      throw new AvatarError("ALREADY_DESTROYED", "Fake renderer has been destroyed");
    }
    this.calls.push({ method: "initialize", input });
    this.initialized = true;
  }

  setState(state: AvatarState): void {
    this.#assertReady();
    this.calls.push({ method: "setState", state });
  }

  setAudioLevel(level: number): void {
    this.#assertReady();
    this.calls.push({ method: "setAudioLevel", level });
  }

  resize(viewport: AvatarViewport): void {
    this.#assertReady();
    this.calls.push({ method: "resize", viewport });
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.initialized = false;
    this.calls.push({ method: "destroy" });
  }

  clearCalls(): void {
    this.calls.length = 0;
  }

  #assertReady(): void {
    if (this.destroyed) {
      throw new AvatarError("ALREADY_DESTROYED", "Fake renderer has been destroyed");
    }
    if (!this.initialized) {
      throw new AvatarError("NOT_INITIALIZED", "Fake renderer is not initialized");
    }
  }
}
