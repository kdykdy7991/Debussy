import { CoreAvatarController } from "../core/controller.js";
import type { AvatarRuntimePort, AvatarSpeechSession } from "../core/runtime.js";
import type {
  AvatarConfig,
  AvatarController,
  AvatarSpeechInput,
  AvatarState,
  CharacterManifest,
} from "../core/types.js";
import type { AvatarViewport } from "../renderers/types.js";
import { FakeAudio } from "./fake-audio.js";
import { FakeRenderer } from "./fake-renderer.js";

export type FakeRuntimeCall =
  | { method: "initialize"; config: AvatarConfig }
  | { method: "show" }
  | { method: "hide" }
  | { method: "destroy" };

export interface FakeAvatarRuntimeOptions {
  container: HTMLElement;
  renderer?: FakeRenderer;
  audio?: FakeAudio;
  fallbackCharacter?: CharacterManifest;
}

export class FakeAvatarRuntime implements AvatarRuntimePort {
  readonly renderer: FakeRenderer;
  readonly audio: FakeAudio;
  readonly calls: FakeRuntimeCall[] = [];
  visible = true;
  destroyed = false;
  readonly #container: HTMLElement;
  readonly #fallbackCharacter: CharacterManifest | undefined;
  #rendererInitialization: AbortController | undefined;

  constructor(options: FakeAvatarRuntimeOptions) {
    this.#container = options.container;
    this.renderer = options.renderer ?? new FakeRenderer();
    this.audio = options.audio ?? new FakeAudio();
    this.#fallbackCharacter = options.fallbackCharacter;
  }

  async initialize(config: AvatarConfig): Promise<{ characterId: string }> {
    this.calls.push({ method: "initialize", config });
    const character = this.#resolveCharacter(config.character);
    const initialization = new AbortController();
    this.#rendererInitialization = initialization;
    await this.renderer.initialize({
      container: this.#container,
      character,
      initialState: "idle",
      signal: initialization.signal,
    });
    return { characterId: character.id };
  }

  setState(state: AvatarState): void {
    this.renderer.setState(state);
  }

  setAudioLevel(level: number): void {
    this.renderer.setAudioLevel(level);
  }

  startSpeech(input: AvatarSpeechInput, signal: AbortSignal): Promise<AvatarSpeechSession> {
    return this.audio.startSpeech(input, signal);
  }

  resize(viewport: AvatarViewport): void {
    this.renderer.resize(viewport);
  }

  show(): void {
    this.visible = true;
    this.calls.push({ method: "show" });
  }

  hide(): void {
    this.visible = false;
    this.calls.push({ method: "hide" });
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.#rendererInitialization?.abort("destroyed");
    this.audio.destroy();
    this.renderer.destroy();
    this.calls.push({ method: "destroy" });
  }

  #resolveCharacter(character: CharacterManifest | string): CharacterManifest {
    if (typeof character !== "string") {
      return character;
    }
    return (
      this.#fallbackCharacter ?? {
        id: character,
        version: "test",
        renderer: "rive",
        assetUrl: character,
        stateMachine: "FakeAvatarState",
        inputs: {},
      }
    );
  }
}

export interface AvatarTestHarness {
  readonly controller: AvatarController;
  readonly runtime: FakeAvatarRuntime;
  readonly renderer: FakeRenderer;
  readonly audio: FakeAudio;
}

export function createAvatarTestHarness(options: FakeAvatarRuntimeOptions): AvatarTestHarness {
  const runtime = new FakeAvatarRuntime(options);
  return {
    controller: new CoreAvatarController(runtime),
    runtime,
    renderer: runtime.renderer,
    audio: runtime.audio,
  };
}
