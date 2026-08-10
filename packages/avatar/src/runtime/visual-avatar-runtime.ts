import { AvatarError } from "../core/errors.js";
import type { AvatarRuntimePort, AvatarSpeechSession } from "../core/runtime.js";
import type {
  AvatarConfig,
  AvatarSpeechInput,
  AvatarState,
  CharacterManifest,
} from "../core/types.js";
import { loadCharacterManifest } from "../manifest/character-manifest.js";
import type { AvatarRenderer, AvatarViewport } from "../renderers/types.js";

type Lifecycle = "new" | "loading" | "ready" | "destroyed";

export interface VisualResizeObserver {
  observe(target: Element): void;
  disconnect(): void;
}

export interface VisualAvatarRuntimeDependencies {
  loadManifest(
    input: CharacterManifest | string,
    options: { signal: AbortSignal },
  ): Promise<CharacterManifest>;
  createRenderer(): Promise<AvatarRenderer>;
  createResizeObserver(callback: () => void): VisualResizeObserver;
  getDevicePixelRatio(): number;
}

async function createRiveRenderer(): Promise<AvatarRenderer> {
  // This is deliberately dynamic: the Rive SDK and WASM loader must not enter
  // the root, Core, or Web Component base chunks.
  const { RiveAvatarRenderer } = await import("../renderers/rive/rive-renderer.js");
  return new RiveAvatarRenderer();
}

export const defaultVisualAvatarRuntimeDependencies: VisualAvatarRuntimeDependencies = {
  loadManifest: (input, options) => loadCharacterManifest(input, options),
  createRenderer: createRiveRenderer,
  createResizeObserver: (callback) => {
    if (typeof ResizeObserver === "undefined") {
      throw new AvatarError(
        "UNSUPPORTED_BROWSER",
        "Avatar preview requires ResizeObserver support",
      );
    }
    return new ResizeObserver(callback);
  },
  getDevicePixelRatio: () =>
    typeof window === "undefined" ? 1 : window.devicePixelRatio,
};

/**
 * Renderer-only production composition used by the first visual preview.
 * Speech is intentionally absent until the later audio phase.
 */
export class VisualAvatarRuntime implements AvatarRuntimePort {
  readonly #container: HTMLElement;
  readonly #dependencies: VisualAvatarRuntimeDependencies;
  #lifecycle: Lifecycle = "new";
  #initializePromise: Promise<{ characterId: string }> | undefined;
  #abortController: AbortController | undefined;
  #renderer: AvatarRenderer | undefined;
  #resizeObserver: VisualResizeObserver | undefined;

  constructor(
    container: HTMLElement,
    dependencies: VisualAvatarRuntimeDependencies = defaultVisualAvatarRuntimeDependencies,
  ) {
    this.#container = container;
    this.#dependencies = dependencies;
  }

  initialize(config: AvatarConfig): Promise<{ characterId: string }> {
    this.#assertNotDestroyed();
    if (this.#lifecycle === "ready") {
      return Promise.resolve({ characterId: this.#requireCharacterId() });
    }
    if (this.#initializePromise) {
      return this.#initializePromise;
    }

    this.#lifecycle = "loading";
    const abortController = new AbortController();
    this.#abortController = abortController;
    const operation = this.#initialize(config, abortController.signal).finally(() => {
      if (this.#initializePromise === operation) {
        this.#initializePromise = undefined;
      }
      if (this.#abortController === abortController) {
        this.#abortController = undefined;
      }
    });
    this.#initializePromise = operation;
    return operation;
  }

  setState(state: AvatarState): void {
    this.#requireRenderer().setState(state);
  }

  setAudioLevel(level: number): void {
    this.#requireRenderer().setAudioLevel(level);
  }

  startSpeech(
    _input: AvatarSpeechInput,
    _signal: AbortSignal,
  ): Promise<AvatarSpeechSession> {
    this.#assertReady();
    return Promise.reject(
      new AvatarError(
        "AUDIO_PLAYBACK_FAILED",
        "Avatar speech is not installed in the visual preview runtime",
      ),
    );
  }

  show(): void {
    this.#assertReady();
    this.#container.hidden = false;
    this.#resizeSafely();
  }

  hide(): void {
    this.#assertReady();
    this.#container.hidden = true;
  }

  destroy(): void {
    if (this.#lifecycle === "destroyed") {
      return;
    }
    this.#lifecycle = "destroyed";
    this.#abortController?.abort("Avatar visual runtime was destroyed");
    this.#abortController = undefined;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#renderer?.destroy();
    this.#renderer = undefined;
    this.#characterId = "";
  }

  async #initialize(
    config: AvatarConfig,
    signal: AbortSignal,
  ): Promise<{ characterId: string }> {
    let renderer: AvatarRenderer | undefined;
    try {
      const character = await this.#dependencies.loadManifest(config.character, { signal });
      this.#throwIfAborted(signal);
      renderer = await this.#dependencies.createRenderer();
      this.#throwIfAborted(signal);
      await renderer.initialize({
        container: this.#container,
        character,
        initialState: "idle",
        signal,
      });
      this.#throwIfAborted(signal);

      this.#renderer = renderer;
      this.#resize(renderer);
      this.#resizeObserver = this.#dependencies.createResizeObserver(() => {
        this.#resizeSafely();
      });
      this.#resizeObserver.observe(this.#container);
      this.#characterId = character.id;
      this.#lifecycle = "ready";
      return { characterId: character.id };
    } catch (cause: unknown) {
      this.#resizeObserver?.disconnect();
      this.#resizeObserver = undefined;
      if (this.#renderer === renderer) {
        this.#renderer = undefined;
      }
      renderer?.destroy();
      if (this.#lifecycle !== "destroyed") {
        this.#lifecycle = "new";
      }
      this.#characterId = "";
      if (cause instanceof AvatarError || this.#isAbortError(cause)) {
        throw cause;
      }
      throw new AvatarError(
        "RENDERER_INITIALIZATION_FAILED",
        "Avatar visual runtime initialization failed",
        { cause },
      );
    }
  }

  #resize(renderer: AvatarRenderer): void {
    const bounds = this.#container.getBoundingClientRect();
    const dpr = this.#dependencies.getDevicePixelRatio();
    const viewport: AvatarViewport = {
      width: Number.isFinite(bounds.width) && bounds.width >= 0 ? bounds.width : 0,
      height: Number.isFinite(bounds.height) && bounds.height >= 0 ? bounds.height : 0,
      devicePixelRatio: Number.isFinite(dpr) && dpr > 0 ? dpr : 1,
    };
    renderer.resize(viewport);
  }

  #resizeSafely(): void {
    if (this.#lifecycle !== "ready" || !this.#renderer) {
      return;
    }
    try {
      this.#resize(this.#renderer);
    } catch {
      // ResizeObserver callbacks must never create an unhandled exception.
      // A later observation or explicit show() retries with fresh dimensions.
    }
  }

  #requireRenderer(): AvatarRenderer {
    this.#assertReady();
    const renderer = this.#renderer;
    if (!renderer) {
      throw new AvatarError("INTERNAL_ERROR", "Avatar visual renderer is unavailable");
    }
    return renderer;
  }

  #requireCharacterId(): string {
    // Core only re-enters initialize after a successful initialization. The ID
    // is retained on the resolved promise rather than exposing manifest state.
    const renderer = this.#renderer;
    if (!renderer) {
      throw new AvatarError("INTERNAL_ERROR", "Avatar visual renderer is unavailable");
    }
    return this.#characterId;
  }

  #characterId = "";

  #assertReady(): void {
    this.#assertNotDestroyed();
    if (this.#lifecycle !== "ready") {
      throw new AvatarError("NOT_INITIALIZED", "Avatar visual runtime is not initialized");
    }
  }

  #assertNotDestroyed(): void {
    if (this.#lifecycle === "destroyed") {
      throw new AvatarError("ALREADY_DESTROYED", "Avatar visual runtime has been destroyed");
    }
  }

  #throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted || this.#lifecycle === "destroyed") {
      throw new DOMException("Avatar visual runtime initialization was aborted", "AbortError");
    }
  }

  #isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
  }
}
