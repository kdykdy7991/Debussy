import { AvatarError, type AvatarErrorCode } from "./errors.js";
import type { AvatarRuntimePort, AvatarSpeechSession } from "./runtime.js";
import { assertAvatarState, AvatarStateMachine } from "./state-machine.js";
import type {
  AvatarConfig,
  AvatarController,
  AvatarEventMap,
  AvatarEventName,
  AvatarSpeechEndReason,
  AvatarSpeechInput,
  AvatarState,
} from "./types.js";

type Lifecycle = "new" | "initializing" | "ready" | "destroyed";

interface ActiveSpeech {
  readonly id: number;
  readonly audioUrl: string;
  readonly abortController: AbortController;
  session?: AvatarSpeechSession;
  started: boolean;
  requestedReason?: "stopped" | "interrupted";
}

/**
 * Framework-neutral orchestration for avatar state, events, and lifecycle.
 * Renderer and audio details are supplied through the internal runtime port.
 */
export class CoreAvatarController implements AvatarController {
  readonly #runtime: AvatarRuntimePort;
  readonly #stateMachine = new AvatarStateMachine();
  #events = new EventTarget();
  #lifecycle: Lifecycle = "new";
  #initializePromise: Promise<void> | undefined;
  #activeSpeech: ActiveSpeech | undefined;
  #nextSpeechId = 0;

  constructor(runtime: AvatarRuntimePort) {
    this.#runtime = runtime;
  }

  get state(): AvatarState {
    return this.#stateMachine.state;
  }

  initialize(config: AvatarConfig): Promise<void> {
    this.#assertNotDestroyed();

    if (this.#lifecycle === "ready") {
      return Promise.resolve();
    }
    if (this.#initializePromise) {
      return this.#initializePromise;
    }

    this.#lifecycle = "initializing";
    const operation = this.#runtime
      .initialize(config)
      .then(({ characterId }) => {
        this.#assertNotDestroyed();
        this.#lifecycle = "ready";
        this.#emit("avatar-ready", { characterId });
      })
      .catch((cause: unknown) => {
        if (this.#lifecycle !== "destroyed") {
          this.#lifecycle = "new";
        }
        const error = this.#asAvatarError(
          cause,
          "RENDERER_INITIALIZATION_FAILED",
          "Avatar initialization failed",
        );
        this.#emitError(error);
        throw error;
      })
      .finally(() => {
        if (this.#initializePromise === operation) {
          this.#initializePromise = undefined;
        }
      });

    this.#initializePromise = operation;
    return operation;
  }

  setState(state: AvatarState): void {
    this.#assertReady();
    assertAvatarState(state);
    if (state === this.state) {
      return;
    }
    this.#runtime.setState(state);
    const transition = this.#stateMachine.transition(state);
    if (!transition) {
      return;
    }
    this.#emit("avatar-state-change", transition);
  }

  setAudioLevel(level: number): void {
    this.#assertReady();
    const normalized = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    this.#runtime.setAudioLevel(normalized);
  }

  async speak(input: AvatarSpeechInput): Promise<void> {
    this.#assertReady();
    this.#validateSpeechInput(input);
    this.#endActiveSpeech("interrupted");

    const active: ActiveSpeech = {
      id: ++this.#nextSpeechId,
      audioUrl: input.audioUrl,
      abortController: new AbortController(),
      started: false,
    };
    this.#activeSpeech = active;

    try {
      const session = await this.#runtime.startSpeech(input, active.abortController.signal);
      if (!this.#isCurrentSpeech(active)) {
        session.stop(active.requestedReason ?? "interrupted");
        return;
      }

      active.session = session;
      active.started = true;
      this.setState("speaking");
      this.#emit("avatar-speech-start", { audioUrl: active.audioUrl });

      const reason = await session.finished;
      if (!this.#isCurrentSpeech(active)) {
        return;
      }
      this.#finishSpeech(active, reason);
    } catch (cause: unknown) {
      if (!this.#isCurrentSpeech(active)) {
        return;
      }

      this.#activeSpeech = undefined;
      this.#runtime.setAudioLevel(0);
      if (active.started) {
        this.#emit("avatar-speech-end", { audioUrl: active.audioUrl, reason: "failed" });
      }
      this.#transitionToIdle();
      const error = this.#asAvatarError(cause, "AUDIO_PLAYBACK_FAILED", "Avatar speech failed");
      this.#emitError(error);
      throw error;
    }
  }

  stopSpeaking(): void {
    this.#assertReady();
    this.#endActiveSpeech("stopped");
  }

  interrupt(): void {
    this.#assertReady();
    this.#endActiveSpeech("interrupted");
    this.#emit("avatar-interrupted", { source: "host" });
  }

  show(): void {
    this.#assertReady();
    this.#runtime.show();
  }

  hide(): void {
    this.#assertReady();
    this.#runtime.hide();
  }

  destroy(): void {
    if (this.#lifecycle === "destroyed") {
      return;
    }

    const wasReady = this.#lifecycle === "ready";
    const active = this.#activeSpeech;
    if (active) {
      active.abortController.abort("interrupted");
      active.session?.stop("interrupted");
      this.#activeSpeech = undefined;
    }
    this.#lifecycle = "destroyed";
    if (wasReady) {
      this.#runtime.setAudioLevel(0);
    }
    this.#runtime.destroy();
    this.#events = new EventTarget();
  }

  addEventListener<Name extends AvatarEventName>(
    type: Name,
    listener: (event: AvatarEventMap[Name]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.#events.addEventListener(type, listener as EventListener, options);
  }

  removeEventListener<Name extends AvatarEventName>(
    type: Name,
    listener: (event: AvatarEventMap[Name]) => void,
    options?: boolean | EventListenerOptions,
  ): void {
    this.#events.removeEventListener(type, listener as EventListener, options);
  }

  #endActiveSpeech(reason: "stopped" | "interrupted"): void {
    const active = this.#activeSpeech;
    if (!active) {
      return;
    }

    active.requestedReason = reason;
    active.abortController.abort(reason);
    active.session?.stop(reason);

    if (!active.started && this.#isCurrentSpeech(active)) {
      this.#activeSpeech = undefined;
      this.#runtime.setAudioLevel(0);
    }
  }

  #finishSpeech(active: ActiveSpeech, reason: AvatarSpeechEndReason): void {
    this.#activeSpeech = undefined;
    this.#runtime.setAudioLevel(0);
    this.#emit("avatar-speech-end", { audioUrl: active.audioUrl, reason });
    this.#transitionToIdle();
  }

  #transitionToIdle(): void {
    const transition = this.#stateMachine.transition("idle");
    if (!transition || this.#lifecycle !== "ready") {
      return;
    }
    this.#runtime.setState("idle");
    this.#emit("avatar-state-change", transition);
  }

  #isCurrentSpeech(active: ActiveSpeech): boolean {
    return this.#activeSpeech?.id === active.id && this.#lifecycle === "ready";
  }

  #assertReady(): void {
    this.#assertNotDestroyed();
    if (this.#lifecycle !== "ready") {
      throw new AvatarError("NOT_INITIALIZED", "Avatar must be initialized before use");
    }
  }

  #assertNotDestroyed(): void {
    if (this.#lifecycle === "destroyed") {
      throw new AvatarError("ALREADY_DESTROYED", "Avatar controller has been destroyed");
    }
  }

  #validateSpeechInput(input: AvatarSpeechInput): void {
    if (!input.audioUrl.trim()) {
      throw new AvatarError("INVALID_CONFIG", "Speech audioUrl must not be empty");
    }
  }

  #emit<Name extends AvatarEventName>(type: Name, detail: AvatarEventMap[Name]["detail"]): void {
    this.#events.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #emitError(error: AvatarError): void {
    const detail: AvatarEventMap["avatar-error"]["detail"] = {
      code: error.code,
      message: error.message,
    };
    if (error.cause !== undefined) {
      detail.cause = error.cause;
    }
    this.#emit("avatar-error", detail);
  }

  #asAvatarError(cause: unknown, code: AvatarErrorCode, message: string): AvatarError {
    return cause instanceof AvatarError ? cause : new AvatarError(code, message, { cause });
  }
}
