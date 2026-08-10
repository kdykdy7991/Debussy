import { AvatarError } from "../../core/errors.js";
import type { AvatarState, CharacterManifest } from "../../core/types.js";
import type {
  AvatarRenderer,
  AvatarRendererFactory,
  AvatarRendererInitialization,
  AvatarViewport,
} from "../types.js";
import {
  defaultRiveRendererDependencies,
  type RiveInputLike,
  type RiveInstanceLike,
  type RiveRendererDependencies,
  StateMachineInputType,
} from "./runtime.js";

type Lifecycle = "new" | "loading" | "ready" | "destroyed";

const AVATAR_STATES: readonly AvatarState[] = [
  "idle",
  "listening",
  "thinking",
  "speaking",
  "error",
];

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(reason: unknown): void;
}

function createDeferred<Value>(): Deferred<Value> {
  let settled = false;
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    },
    reject: (reason) => {
      if (!settled) {
        settled = true;
        rejectPromise(reason);
      }
    },
  };
}

/** Concrete Canvas/WASM renderer. Kept behind the internal AvatarRenderer boundary. */
export class RiveAvatarRenderer implements AvatarRenderer {
  readonly #dependencies: RiveRendererDependencies;
  #lifecycle: Lifecycle = "new";
  #initializePromise: Promise<void> | undefined;
  #canvas: HTMLCanvasElement | undefined;
  #instance: RiveInstanceLike | undefined;
  #character: CharacterManifest | undefined;
  #cancelInitialization: (() => void) | undefined;
  #inputs = new Map<string, RiveInputLike>();

  constructor(dependencies: RiveRendererDependencies = defaultRiveRendererDependencies) {
    this.#dependencies = dependencies;
  }

  initialize(input: AvatarRendererInitialization): Promise<void> {
    this.#assertNotDestroyed();
    if (this.#lifecycle === "ready") {
      return Promise.resolve();
    }
    if (this.#initializePromise) {
      return this.#initializePromise;
    }
    if (input.signal.aborted) {
      return Promise.reject(this.#abortError());
    }

    this.#lifecycle = "loading";
    const operation = this.#initialize(input).finally(() => {
      if (this.#initializePromise === operation) {
        this.#initializePromise = undefined;
      }
    });
    this.#initializePromise = operation;
    return operation;
  }

  setState(state: AvatarState): void {
    this.#assertReady();
    const character = this.#requireCharacter();

    for (const mappedState of AVATAR_STATES) {
      const inputName = character.inputs[mappedState];
      if (!inputName) {
        continue;
      }
      const riveInput = this.#requireInput(inputName);
      const active = mappedState === state;
      switch (riveInput.type) {
        case StateMachineInputType.Boolean:
          riveInput.value = active;
          break;
        case StateMachineInputType.Number:
          riveInput.value = active ? 1 : 0;
          break;
        case StateMachineInputType.Trigger:
          if (active) {
            riveInput.fire();
          }
          break;
        default:
          throw new AvatarError(
            "INVALID_MANIFEST",
            `Unsupported Rive input type for state ${mappedState}: ${riveInput.type}`,
          );
      }
    }
  }

  setAudioLevel(level: number): void {
    this.#assertReady();
    const inputName = this.#requireCharacter().inputs.audioLevel;
    if (!inputName) {
      return;
    }
    const riveInput = this.#requireInput(inputName);
    if (riveInput.type !== StateMachineInputType.Number) {
      throw new AvatarError(
        "INVALID_MANIFEST",
        `Rive audioLevel input must be Number: ${inputName}`,
      );
    }
    riveInput.value = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  }

  resize(viewport: AvatarViewport): void {
    this.#assertReady();
    if (
      !Number.isFinite(viewport.width) ||
      viewport.width < 0 ||
      !Number.isFinite(viewport.height) ||
      viewport.height < 0 ||
      !Number.isFinite(viewport.devicePixelRatio) ||
      viewport.devicePixelRatio <= 0
    ) {
      throw new AvatarError("INVALID_CONFIG", "Avatar viewport values are invalid");
    }
    const canvas = this.#requireCanvas();
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    this.#requireInstance().resizeDrawingSurfaceToCanvas(viewport.devicePixelRatio);
  }

  destroy(): void {
    if (this.#lifecycle === "destroyed") {
      return;
    }
    this.#lifecycle = "destroyed";
    this.#cancelInitialization?.();
    this.#cancelInitialization = undefined;
    this.#cleanupInstance();
    this.#removeCanvas();
    this.#inputs.clear();
    this.#character = undefined;
  }

  async #initialize(input: AvatarRendererInitialization): Promise<void> {
    const loaded = createDeferred<void>();
    let abortHandler: (() => void) | undefined;

    try {
      const canvas = this.#dependencies.createCanvas();
      canvas.setAttribute("data-avatar-renderer", "rive");
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.display = "block";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      input.container.appendChild(canvas);
      this.#canvas = canvas;
      this.#character = input.character;

      abortHandler = () => {
        this.#cleanupInstance();
        this.#removeCanvas();
        loaded.reject(this.#abortError());
      };
      this.#cancelInitialization = abortHandler;
      input.signal.addEventListener("abort", abortHandler, { once: true });

      const instance = this.#dependencies.createInstance({
        canvas,
        src: input.character.assetUrl,
        stateMachines: input.character.stateMachine,
        autoplay: true,
        shouldDisableRiveListeners: true,
        automaticallyHandleEvents: false,
        onLoad: () => loaded.resolve(undefined),
        onLoadError: (event) => {
          const detail = typeof event.data === "string" ? `: ${event.data}` : "";
          loaded.reject(
            new AvatarError(
              "RENDERER_INITIALIZATION_FAILED",
              `Rive character failed to load${detail}`,
            ),
          );
        },
      });
      this.#instance = instance;

      if (input.signal.aborted) {
        abortHandler();
      }
      await loaded.promise;
      this.#assertNotDestroyed();
      this.#cacheAndValidateInputs(input.character, instance);
      this.#lifecycle = "ready";
      this.setState(input.initialState);
      this.setAudioLevel(0);
      instance.resizeDrawingSurfaceToCanvas();
    } catch (cause: unknown) {
      if (this.#lifecycle !== "destroyed") {
        this.#lifecycle = "new";
      }
      this.#cleanupInstance();
      this.#removeCanvas();
      this.#inputs.clear();
      this.#character = undefined;
      if (cause instanceof AvatarError || this.#isAbortError(cause)) {
        throw cause;
      }
      throw new AvatarError(
        "RENDERER_INITIALIZATION_FAILED",
        "Rive renderer initialization failed",
        { cause },
      );
    } finally {
      if (abortHandler) {
        input.signal.removeEventListener("abort", abortHandler);
      }
      if (this.#cancelInitialization === abortHandler) {
        this.#cancelInitialization = undefined;
      }
    }
  }

  #cacheAndValidateInputs(character: CharacterManifest, instance: RiveInstanceLike): void {
    const inputs = instance.stateMachineInputs(character.stateMachine);
    this.#inputs = new Map(inputs.map((input) => [input.name, input]));
    const mappedNames = Object.values(character.inputs).filter(
      (name): name is string => name !== undefined,
    );
    if (new Set(mappedNames).size !== mappedNames.length) {
      throw new AvatarError("INVALID_MANIFEST", "Rive input mappings must be unique");
    }
    for (const inputName of mappedNames) {
      if (!this.#inputs.has(inputName)) {
        throw new AvatarError("INVALID_MANIFEST", `Rive input not found: ${inputName}`);
      }
    }
    const audioInputName = character.inputs.audioLevel;
    if (
      audioInputName &&
      this.#requireInput(audioInputName).type !== StateMachineInputType.Number
    ) {
      throw new AvatarError(
        "INVALID_MANIFEST",
        `Rive audioLevel input must be Number: ${audioInputName}`,
      );
    }
  }

  #assertReady(): void {
    this.#assertNotDestroyed();
    if (this.#lifecycle !== "ready") {
      throw new AvatarError("NOT_INITIALIZED", "Rive renderer is not initialized");
    }
  }

  #assertNotDestroyed(): void {
    if (this.#lifecycle === "destroyed") {
      throw new AvatarError("ALREADY_DESTROYED", "Rive renderer has been destroyed");
    }
  }

  #requireCharacter(): CharacterManifest {
    if (!this.#character) {
      throw new AvatarError("NOT_INITIALIZED", "Rive renderer has no character");
    }
    return this.#character;
  }

  #requireCanvas(): HTMLCanvasElement {
    if (!this.#canvas) {
      throw new AvatarError("NOT_INITIALIZED", "Rive renderer has no canvas");
    }
    return this.#canvas;
  }

  #requireInstance(): RiveInstanceLike {
    if (!this.#instance) {
      throw new AvatarError("NOT_INITIALIZED", "Rive renderer has no runtime instance");
    }
    return this.#instance;
  }

  #requireInput(name: string): RiveInputLike {
    const input = this.#inputs.get(name);
    if (!input) {
      throw new AvatarError("INVALID_MANIFEST", `Rive input not found: ${name}`);
    }
    return input;
  }

  #cleanupInstance(): void {
    const instance = this.#instance;
    this.#instance = undefined;
    instance?.cleanup();
  }

  #removeCanvas(): void {
    const canvas = this.#canvas;
    this.#canvas = undefined;
    canvas?.remove();
  }

  #abortError(): DOMException {
    return new DOMException("Rive renderer initialization was aborted", "AbortError");
  }

  #isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
  }
}

export class RiveAvatarRendererFactory implements AvatarRendererFactory {
  readonly type = "rive" as const;
  readonly #dependencies: RiveRendererDependencies;

  constructor(dependencies: RiveRendererDependencies = defaultRiveRendererDependencies) {
    this.#dependencies = dependencies;
  }

  create(): AvatarRenderer {
    return new RiveAvatarRenderer(this.#dependencies);
  }
}
