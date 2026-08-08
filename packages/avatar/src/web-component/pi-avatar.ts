import { AvatarError } from "../core/index.js";
import type {
  AvatarConfig,
  AvatarController,
  AvatarEventMap,
  AvatarEventName,
  AvatarSpeechInput,
  AvatarState,
} from "../core/index.js";

/**
 * A controller factory is how `<pi-avatar>` obtains its `AvatarController`.
 *
 * The production composition layer (renderer + audio + manifest loading) is not
 * part of B2; until it exists, tests and hosts register a factory through
 * `setControllerFactory`. The factory receives the Shadow DOM stage container so
 * the renderer can initialize into it.
 */
export type AvatarControllerFactory = (container: HTMLElement) => AvatarController;

let controllerFactory: AvatarControllerFactory | undefined;

/** Replace the factory used to create controllers for new element instances. */
export function setControllerFactory(factory: AvatarControllerFactory | undefined): void {
  controllerFactory = factory;
}

export function getControllerFactory(): AvatarControllerFactory | undefined {
  return controllerFactory;
}

const OBSERVED_ATTRIBUTES = [
  "character",
  "state",
  "mode",
  "position",
  "width",
  "height",
  "background",
  "autoplay",
] as const;

/** The six public events are forwarded unchanged from the controller. */
const FORWARDED_EVENT_TYPES: AvatarEventName[] = [
  "avatar-ready",
  "avatar-state-change",
  "avatar-speech-start",
  "avatar-speech-end",
  "avatar-error",
  "avatar-interrupted",
];

function parseState(value: string | null): AvatarState | undefined {
  if (
    value === "idle" ||
    value === "listening" ||
    value === "thinking" ||
    value === "speaking" ||
    value === "error"
  ) {
    return value;
  }
  return undefined;
}

/** Attributes come through as strings; bare numbers become CSS pixel lengths. */
function normalizeSize(value: string): string {
  return /^\d+(\.\d+)?$/.test(value) ? `${value}px` : value;
}

/**
 * Framework-neutral `<pi-avatar>` custom element (task B2).
 *
 * Attribute surface is limited to serializable config; complex control happens
 * through the element methods, which mirror `AvatarController`. Controller
 * events are re-dispatched on the element with the same names and detail, so a
 * host can observe the six standard events directly on the element.
 */
export class PiAvatarElement extends HTMLElement {
  static readonly observedAttributes = OBSERVED_ATTRIBUTES;

  #controller: AvatarController | undefined;
  #stage: HTMLElement | undefined;
  #initialized = false;
  #handlers: Array<{ type: AvatarEventName; handler: EventListener }> = [];

  get state(): AvatarState {
    return this.#controller?.state ?? "idle";
  }

  connectedCallback(): void {
    this.#setup();
  }

  disconnectedCallback(): void {
    this.#teardown();
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    switch (name) {
      case "state":
        this.#applyStateAttribute(newValue);
        break;
      case "character":
        // Re-initialize with the new character once a prior initialize finished.
        if (newValue !== null && this.#initialized) {
          this.#teardown();
          this.#setup();
        }
        break;
      case "mode":
      case "position":
      case "width":
      case "height":
      case "background":
        this.#applyLayoutAttributes();
        break;
      case "autoplay":
        // Only relevant at connect time.
        break;
    }
  }

  initialize(config?: AvatarConfig): Promise<void> {
    if (!this.#controller) {
      if (!this.#createController()) {
        throw new AvatarError(
          "NOT_INITIALIZED",
          "pi-avatar has no controller and no controller factory is configured",
        );
      }
    }
    const controller = this.#requireController();
    const resolved = config ?? this.#configFromAttributes();
    if (!resolved.character) {
      throw new AvatarError("INVALID_CONFIG", "pi-avatar initialize requires a character");
    }
    const initial = parseState(this.getAttribute("state"));
    return controller.initialize(resolved).then(() => {
      this.#initialized = true;
      if (initial !== undefined && initial !== controller.state) {
        controller.setState(initial);
      }
    });
  }

  setState(state: AvatarState): void {
    this.#requireController().setState(state);
  }

  setAudioLevel(level: number): void {
    this.#requireController().setAudioLevel(level);
  }

  speak(input: AvatarSpeechInput): Promise<void> {
    return this.#requireController().speak(input);
  }

  stopSpeaking(): void {
    this.#requireController().stopSpeaking();
  }

  /** Mirrors the controller: forwards `source: "host"` and still emits when idle (Q1/Q2). */
  interrupt(): void {
    this.#requireController().interrupt();
  }

  show(): void {
    this.#requireController().show();
  }

  hide(): void {
    this.#requireController().hide();
  }

  destroy(): void {
    this.#teardown();
  }

  #setup(): void {
    if (this.#controller) {
      return;
    }
    if (!this.#createController()) {
      return;
    }
    if (this.#shouldAutoInitialize()) {
      // Initialization failures surface as `avatar-error`; catching keeps the
      // auto-init promise from becoming an unhandled rejection.
      void this.initialize().catch(() => undefined);
    }
  }

  #createController(): boolean {
    const factory = getControllerFactory();
    if (!factory) {
      this.#dispatchError(
        new AvatarError(
          "INTERNAL_ERROR",
          "No avatar controller factory is configured for <pi-avatar>",
        ),
      );
      return false;
    }
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    const stage = this.#getOrCreateStage();
    this.#stage = stage;
    const controller = factory(stage);
    this.#controller = controller;
    this.#bindControllerEvents(controller);
    this.#applyLayoutAttributes();
    return true;
  }

  #teardown(): void {
    this.#removeControllerHandlers();
    this.#controller?.destroy();
    this.#controller = undefined;
    this.#initialized = false;
  }

  #requireController(): AvatarController {
    const controller = this.#controller;
    if (!controller) {
      throw new AvatarError("NOT_INITIALIZED", "pi-avatar has no controller");
    }
    return controller;
  }

  #shouldAutoInitialize(): boolean {
    return this.hasAttribute("character") && this.getAttribute("autoplay") !== "false";
  }

  #configFromAttributes(): AvatarConfig {
    const config: AvatarConfig = { character: this.getAttribute("character") ?? "" };
    const mode = this.getAttribute("mode");
    if (mode === "inline" || mode === "floating") {
      config.mode = mode;
    }
    const position = this.getAttribute("position");
    if (position === "bottom-left" || position === "bottom-right") {
      config.position = position;
    }
    const width = this.getAttribute("width");
    if (width !== null) {
      config.width = normalizeSize(width);
    }
    const height = this.getAttribute("height");
    if (height !== null) {
      config.height = normalizeSize(height);
    }
    const background = this.getAttribute("background");
    if (background !== null) {
      config.background = background;
    }
    const autoplay = this.getAttribute("autoplay");
    if (autoplay !== null) {
      config.autoplay = autoplay !== "false";
    }
    return config;
  }

  #applyStateAttribute(value: string | null): void {
    const controller = this.#controller;
    if (!controller || value === null) {
      return;
    }
    const state = parseState(value);
    if (state === undefined) {
      this.#dispatchError(
        new AvatarError("INVALID_CONFIG", `Unknown avatar state attribute: ${value}`),
      );
      return;
    }
    controller.setState(state);
  }

  #getOrCreateStage(): HTMLElement {
    const shadow = this.shadowRoot;
    if (!shadow) {
      throw new Error("pi-avatar has no shadow root");
    }
    let stage = shadow.querySelector<HTMLElement>("[data-avatar-stage]");
    if (!stage) {
      stage = document.createElement("div");
      stage.setAttribute("data-avatar-stage", "");
      shadow.appendChild(stage);
    }
    return stage;
  }

  #applyLayoutAttributes(): void {
    if (!this.#stage) {
      return;
    }
    const width = this.getAttribute("width");
    if (width !== null) {
      this.#stage.style.width = normalizeSize(width);
    }
    const height = this.getAttribute("height");
    if (height !== null) {
      this.#stage.style.height = normalizeSize(height);
    }
    const background = this.getAttribute("background");
    if (background !== null) {
      this.#stage.style.background = background;
    }
    // Seeded for task B3; inline/floating positioning is out of B2 scope.
    this.#stage.setAttribute("data-avatar-mode", this.getAttribute("mode") ?? "inline");
    this.#stage.setAttribute(
      "data-avatar-position",
      this.getAttribute("position") ?? "bottom-right",
    );
  }

  #bindControllerEvents(controller: AvatarController): void {
    for (const type of FORWARDED_EVENT_TYPES) {
      const handler: EventListener = (event: Event): void => {
        const detail = (event as CustomEvent).detail;
        if (type === "avatar-state-change") {
          const current = (detail as { current: AvatarState }).current;
          if (this.getAttribute("state") !== current) {
            this.setAttribute("state", current);
          }
        }
        this.dispatchEvent(new CustomEvent(type, { detail }));
      };
      controller.addEventListener(type, handler);
      this.#handlers.push({ type, handler });
    }
  }

  #removeControllerHandlers(): void {
    const controller = this.#controller;
    if (!controller) {
      return;
    }
    for (const { type, handler } of this.#handlers) {
      controller.removeEventListener(type, handler);
    }
    this.#handlers = [];
  }

  #dispatchError(error: AvatarError): void {
    const detail: AvatarEventMap["avatar-error"]["detail"] = {
      code: error.code,
      message: error.message,
    };
    if (error.cause !== undefined) {
      detail.cause = error.cause;
    }
    this.dispatchEvent(new CustomEvent("avatar-error", { detail }));
  }
}

/**
 * Register `<pi-avatar>` unless it is already registered. The web-component
 * entry is the only place allowed to define the element (ADR-0001); the guard
 * keeps double-loading the entry safe.
 */
export function registerPiAvatarElement(): void {
  if (typeof customElements !== "undefined" && !customElements.get("pi-avatar")) {
    customElements.define("pi-avatar", PiAvatarElement);
  }
}
