import { AvatarError } from "../core/index.js";
import type {
  AvatarConfig,
  AvatarController,
  AvatarDisplayMode,
  AvatarEventMap,
  AvatarEventName,
  AvatarPosition,
  AvatarSpeechInput,
  AvatarState,
} from "../core/index.js";
import { createVisualAvatarController } from "../runtime/index.js";

/**
 * A controller factory is how `<pi-avatar>` obtains its `AvatarController`.
 *
 * The factory receives the Shadow DOM stage container. Production defaults to
 * the renderer-only Visual Runtime; tests and specialized hosts may override it.
 */
export type AvatarControllerFactory = (container: HTMLElement) => AvatarController;

let controllerFactory: AvatarControllerFactory | undefined;

const defaultControllerFactory: AvatarControllerFactory = (container) =>
  createVisualAvatarController(container);

/** Replace the factory used to create controllers for new element instances. */
export function setControllerFactory(factory: AvatarControllerFactory | undefined): void {
  controllerFactory = factory;
}

export function getControllerFactory(): AvatarControllerFactory {
  return controllerFactory ?? defaultControllerFactory;
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
 * Layout CSS (task B3). It lives inside the shadow root in a single
 * `<style data-avatar-layout>` per element instance, so it never reaches the
 * host document. The five custom properties are the frozen defaults and may be
 * overridden by the host on the `<pi-avatar>` element itself. Inline is the
 * default mode: an invalid/absent `mode` never matches `[mode="floating"]` and
 * stays in the document flow; floating opts into fixed positioning with
 * safe-area-aware offsets. `width`/`height` HTML attributes win over the CSS
 * variables because B3 lands their inline styles on the host after these rules.
 *
 * B3 Review #2: floating caps its size against the *available* viewport. A
 * `max-width: 100vw` on a fixed element that is also inset by `offset-x` +
 * safe-area would let a full-width host overflow the opposite edge (e.g. a
 * 320px host on a 320px viewport would stick out 16px on the left). The
 * floating rules therefore subtract both configured offsets and all safe-area
 * insets, keeping the element inside the viewport regardless of which corner
 * it anchors to.
 */
const AVATAR_LAYOUT_CSS = `
  :host {
    --pi-avatar-width: 320px;
    --pi-avatar-height: 480px;
    --pi-avatar-z-index: 1000;
    --pi-avatar-offset-x: 16px;
    --pi-avatar-offset-y: 16px;

    display: block;
    width: var(--pi-avatar-width);
    height: var(--pi-avatar-height);
    max-width: 100vw;
    max-height: 100vh;
    max-height: 100dvh;
    box-sizing: border-box;
  }

  /* Missing or invalid mode never matches, so the element stays inline. */
  :host([mode="floating"]) {
    position: fixed;
    z-index: var(--pi-avatar-z-index);
    right: calc(var(--pi-avatar-offset-x) + env(safe-area-inset-right));
    bottom: calc(var(--pi-avatar-offset-y) + env(safe-area-inset-bottom));
    /* Reserve the offset and safe-area on both edges so the same rule bounds
       either corner; 100vh is the fallback for engines without 100dvh. */
    max-width: calc(
      100vw
      - var(--pi-avatar-offset-x) * 2
      - env(safe-area-inset-left)
      - env(safe-area-inset-right)
    );
    max-height: calc(
      100vh
      - var(--pi-avatar-offset-y) * 2
      - env(safe-area-inset-top)
      - env(safe-area-inset-bottom)
    );
    max-height: calc(
      100dvh
      - var(--pi-avatar-offset-y) * 2
      - env(safe-area-inset-top)
      - env(safe-area-inset-bottom)
    );
  }

  /* Missing or invalid position never matches, so floating defaults to
     bottom-right. */
  :host([mode="floating"][position="bottom-left"]) {
    right: auto;
    left: calc(var(--pi-avatar-offset-x) + env(safe-area-inset-left));
  }

  [data-avatar-stage] {
    display: block;
    width: 100%;
    height: 100%;
    max-width: 100vw;
    max-height: 100vh;
    max-height: 100dvh;
    overflow: hidden;
    box-sizing: border-box;
  }
`;

/**
 * Base for `<pi-avatar>`. In a browser this is exactly `HTMLElement`, so B2/B3
 * behavior is unchanged. When the module is evaluated in a DOM-less Node/SSR
 * environment (e.g. importing the `@skdy/avatar` root entry for the embed
 * surface, B4 Review #1), `HTMLElement` is undefined and a bare
 * `extends HTMLElement` would throw a ReferenceError at module load. Falling
 * back to a plain class lets the module evaluate; the instance methods that
 * touch the DOM are only ever called once a real element exists, so they are
 * unaffected.
 */
const BaseHTMLElement = (typeof HTMLElement !== "undefined" ? HTMLElement : class {}) as typeof HTMLElement;

/**
 * Framework-neutral `<pi-avatar>` custom element (task B2).
 *
 * Attribute surface is limited to serializable config; complex control happens
 * through the element methods, which mirror `AvatarController`. Controller
 * events are re-dispatched on the element with the same names and detail, so a
 * host can observe the six standard events directly on the element.
 */
export class PiAvatarElement extends BaseHTMLElement {
  static readonly observedAttributes = OBSERVED_ATTRIBUTES;

  #controller: AvatarController | undefined;
  #stage: HTMLElement | undefined;
  /** Set while the current controller's initialize is still in flight. */
  #initializePromise: Promise<void> | undefined;
  /** Latest state requested while initializing; applied once init succeeds. */
  #pendingState: AvatarState | undefined;
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
        // The latest character must win: restart whenever a controller exists,
        // even if a prior initialize is still in flight (B2 Review #1).
        if (newValue !== null && this.#controller) {
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
      this.#createController();
    }
    const controller = this.#requireController();
    const resolved = config ?? this.#configFromAttributes();
    if (!resolved.character) {
      throw new AvatarError("INVALID_CONFIG", "pi-avatar initialize requires a character");
    }
    const initial = parseState(this.getAttribute("state"));
    const operation = controller.initialize(resolved)
      .then(() => {
        // A character change / reconnect may have torn this controller down while
        // it was initializing; only the current controller may drive the element
        // (B2 Review #1 — the latest character must win).
        if (this.#controller !== controller) {
          return;
        }
        // Apply the latest state requested during initialization instead of
        // dropping it or throwing NOT_INITIALIZED (B2 Review #2).
        const state = this.#pendingState ?? initial;
        this.#pendingState = undefined;
        if (state !== undefined && state !== controller.state) {
          controller.setState(state);
        }
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
    const parsed = parseState(state);
    if (parsed === undefined) {
      throw new AvatarError("INVALID_CONFIG", `Unknown avatar state: ${String(state)}`);
    }
    const controller = this.#controller;
    if (!controller) {
      throw new AvatarError("NOT_INITIALIZED", "pi-avatar has no controller");
    }
    if (this.#initializePromise) {
      // The controller is not ready yet; defer the state and apply it once
      // initialization succeeds (B2 Review #2).
      this.#pendingState = parsed;
      return;
    }
    controller.setState(parsed);
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
    this.#createController();
    if (this.#shouldAutoInitialize()) {
      // Initialization failures surface as `avatar-error`; catching keeps the
      // auto-init promise from becoming an unhandled rejection.
      void this.initialize().catch(() => undefined);
    }
  }

  #createController(): void {
    const factory = getControllerFactory();
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    // One `<style data-avatar-layout>` per element instance; reconnect reuses
    // the existing style instead of inserting a second one (task B3 §4.1).
    this.#ensureLayoutStyle();
    const stage = this.#getOrCreateStage();
    this.#stage = stage;
    const controller = factory(stage);
    this.#controller = controller;
    this.#bindControllerEvents(controller);
    this.#applyLayoutAttributes();
  }

  #teardown(): void {
    this.#removeControllerHandlers();
    this.#controller?.destroy();
    this.#controller = undefined;
    this.#initializePromise = undefined;
    this.#pendingState = undefined;
  }

  #requireController(): AvatarController {
    const controller = this.#controller;
    if (!controller) {
      throw new AvatarError("NOT_INITIALIZED", "pi-avatar has no controller");
    }
    return controller;
  }

  /**
   * Connecting auto-initializes whenever a character is present. `autoplay` is
   * not an initialization gate: it only flows into the controller config, which
   * decides whether speech starts automatically (B2 Review #3).
   */
  #shouldAutoInitialize(): boolean {
    return this.hasAttribute("character");
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
    if (this.#initializePromise) {
      // Applied after initialization succeeds. States the controller has already
      // reached (idle, or the value just applied via the reflected event) need
      // no deferral (B2 Review #2).
      if (controller.state !== state) {
        this.#pendingState = state;
      }
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

  /**
   * Ensures exactly one layout `<style>` exists in the shadow root. Reconnect
   * keeps the same shadow root, so the guard prevents a second style from being
   * inserted (task B3 §4.1). The CSS never reaches the host document.
   */
  #ensureLayoutStyle(): void {
    const shadow = this.shadowRoot;
    if (!shadow) {
      return;
    }
    if (shadow.querySelector("[data-avatar-layout]")) {
      return;
    }
    const style = document.createElement("style");
    style.setAttribute("data-avatar-layout", "");
    style.textContent = AVATAR_LAYOUT_CSS;
    shadow.appendChild(style);
  }

  /**
   * `data-avatar-mode` / `data-avatar-position` only ever carry canonical values;
   * invalid input falls back to the defaults instead of leaking the raw string
   * into the DOM (task B3 §6).
   */
  #canonicalMode(): AvatarDisplayMode {
    return this.getAttribute("mode") === "floating" ? "floating" : "inline";
  }

  #canonicalPosition(): AvatarPosition {
    return this.getAttribute("position") === "bottom-left" ? "bottom-left" : "bottom-right";
  }

  #applyLayoutAttributes(): void {
    if (!this.#stage) {
      return;
    }
    // `width`/`height` HTML attributes win over the CSS custom properties, so
    // their inline styles land on the host (B3 §4.5). A bare number becomes a
    // CSS pixel length. The stage is intentionally NOT sized inline: it fills
    // the host via `[data-avatar-stage] { width: 100%; height: 100% }`, and
    // sizing both would compound percentages (host 50% → stage 25% of the
    // container, B3 Review #1).
    const width = this.getAttribute("width");
    this.style.width = width !== null ? normalizeSize(width) : "";
    const height = this.getAttribute("height");
    this.style.height = height !== null ? normalizeSize(height) : "";
    // Background stays on the stage, the container the renderer draws into.
    // A removed attribute clears the inline style (B2 Review #4).
    const background = this.getAttribute("background");
    this.#stage.style.background = background !== null ? background : "";
    // Canonical values only; invalid input falls back per task B3 §4.2/§4.3.
    this.#stage.setAttribute("data-avatar-mode", this.#canonicalMode());
    this.#stage.setAttribute("data-avatar-position", this.#canonicalPosition());
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
