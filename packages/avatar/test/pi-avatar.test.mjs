import assert from "node:assert/strict";
import test from "node:test";

import { AvatarError } from "../dist/core/index.js";
import { createAvatarTestHarness } from "../dist/testing/index.js";
import { flush, installDomShim } from "./helpers/dom-shim.mjs";

// The element module reads globalThis.HTMLElement at load time, so install the
// shim before importing it.
installDomShim();
const { PiAvatarElement, setControllerFactory } = await import(
  "../dist/web-component/index.js"
);
const { getControllerFactory } = await import("../dist/web-component/pi-avatar.js");

/** Each connect call creates a fresh harness so reconnect is observable. */
function makeFactory() {
  let harness;
  const factory = (container) => {
    harness = createAvatarTestHarness({ container });
    return harness.controller;
  };
  return { factory, getHarness: () => harness };
}

function connectedCharacterElement(attributes = {}) {
  const element = new PiAvatarElement();
  element.setAttribute("character", "/characters/demo/manifest.json");
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.connectedCallback();
  return element;
}

test("registers <pi-avatar> when the entry is loaded", () => {
  assert.equal(customElements.get("pi-avatar"), PiAvatarElement);
});

test("guarded registration never replaces an existing definition", async () => {
  // The module-level registration must not clobber a pre-existing element.
  const { registerPiAvatarElement } = await import("../dist/web-component/index.js");
  registerPiAvatarElement();
  assert.equal(customElements.get("pi-avatar"), PiAvatarElement);
});

test("controller factory can override and restore the production default", () => {
  const override = () => createAvatarTestHarness({ container: {} }).controller;
  setControllerFactory(override);
  assert.equal(getControllerFactory(), override);

  setControllerFactory(undefined);
  const restored = getControllerFactory();
  assert.notEqual(restored, override);
  assert.equal(typeof restored, "function");
});

test("attribute mapping drives controller initialization", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  const element = new PiAvatarElement();
  element.setAttribute("character", "/characters/demo/manifest.json");
  element.setAttribute("mode", "floating");
  element.setAttribute("position", "bottom-right");
  element.setAttribute("width", "320");
  element.setAttribute("height", "480");
  element.connectedCallback();
  await flush();

  const harness = getHarness();
  assert.equal(harness.runtime.calls[0].method, "initialize");
  assert.deepEqual(harness.runtime.calls[0].config, {
    character: "/characters/demo/manifest.json",
    mode: "floating",
    position: "bottom-right",
    width: "320px",
    height: "480px",
  });

  // The renderer receives the Shadow DOM stage as its container.
  const initializeCall = harness.renderer.calls[0];
  assert.equal(initializeCall.method, "initialize");
  assert.equal(initializeCall.input.initialState, "idle");
  assert.equal(
    initializeCall.input.container.getAttribute("data-avatar-stage"),
    "",
  );
  assert.equal(initializeCall.input.character.id, "/characters/demo/manifest.json");
});

test("Shadow DOM stage container is styled from serializable attributes", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  const element = new PiAvatarElement();
  element.setAttribute("character", "/characters/demo/manifest.json");
  element.setAttribute("mode", "floating");
  element.setAttribute("position", "bottom-right");
  element.setAttribute("width", "320");
  element.setAttribute("height", "480");
  element.setAttribute("background", "#101010");
  element.connectedCallback();
  await flush();

  const stage = getHarness().renderer.calls[0].input.container;
  assert.equal(stage.getAttribute("data-avatar-stage"), "");
  assert.equal(stage.getAttribute("data-avatar-mode"), "floating");
  assert.equal(stage.getAttribute("data-avatar-position"), "bottom-right");
  // Sizes land on the host; the stage keeps its 100%/100% CSS fill (B3).
  assert.equal(element.style.width, "320px");
  assert.equal(element.style.height, "480px");
  assert.equal(stage.style.background, "#101010");
});

test("auto-initializes on connect and forwards avatar-ready", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  const element = connectedCharacterElement();
  const ready = [];
  element.addEventListener("avatar-ready", (event) => ready.push(event.detail));
  await flush();

  assert.equal(getHarness().renderer.calls.filter((c) => c.method === "initialize").length, 1);
  assert.deepEqual(ready, [{ characterId: "/characters/demo/manifest.json" }]);
});

test("proxies controller methods and exposes the state getter", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  const element = connectedCharacterElement();
  await flush();

  element.setState("thinking");
  element.setAudioLevel(0.5);
  element.show();
  element.hide();

  const calls = getHarness().renderer.calls;
  assert.ok(calls.some((c) => c.method === "setState" && c.state === "thinking"));
  assert.ok(calls.some((c) => c.method === "setAudioLevel" && c.level === 0.5));
  assert.equal(getHarness().runtime.visible, false);
  assert.equal(element.state, "thinking");
});

test("speak proxies through and forwards speech lifecycle events", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  const element = connectedCharacterElement();
  await flush();

  const events = [];
  element.addEventListener("avatar-speech-start", (e) => events.push(["start", e.detail]));
  element.addEventListener("avatar-speech-end", (e) => events.push(["end", e.detail]));

  const speaking = element.speak({ audioUrl: "/answer.wav" });
  await flush();
  assert.equal(getHarness().audio.hasActiveSpeech, true);
  getHarness().audio.finishSpeech("completed");
  await speaking;

  assert.deepEqual(events, [
    ["start", { audioUrl: "/answer.wav" }],
    ["end", { audioUrl: "/answer.wav", reason: "completed" }],
  ]);
});

test("interrupt mirrors controller semantics (Q1/Q2)", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  const element = connectedCharacterElement();
  await flush();

  const interrupted = [];
  element.addEventListener("avatar-interrupted", (e) => interrupted.push(e.detail));

  // Q2: interrupt with no active speech still emits avatar-interrupted.
  element.interrupt();
  assert.deepEqual(interrupted, [{ source: "host" }]);

  // Q1: the forwarded source stays "host" for element-triggered interrupts.
  const speaking = element.speak({ audioUrl: "/answer.wav" });
  await flush();
  element.interrupt();
  await speaking;
  assert.equal(interrupted.at(-1).source, "host");
});

test("state attribute reflects controller state and applies host setState", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  const element = connectedCharacterElement();
  await flush();

  element.setState("thinking");
  assert.equal(element.getAttribute("state"), "thinking");

  element.setAttribute("state", "listening");
  assert.ok(
    getHarness().renderer.calls.some((c) => c.method === "setState" && c.state === "listening"),
  );
});

test("invalid state attribute surfaces avatar-error with INVALID_CONFIG", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  const element = connectedCharacterElement();
  await flush();

  const errors = [];
  element.addEventListener("avatar-error", (e) => errors.push(e.detail));
  element.setAttribute("state", "dancing");

  assert.equal(errors.at(-1).code, "INVALID_CONFIG");
});

test("restoring the default factory creates a controller but commands still require initialization", async () => {
  setControllerFactory(undefined);
  const element = new PiAvatarElement();
  const errors = [];
  element.addEventListener("avatar-error", (e) => errors.push(e.detail));
  element.connectedCallback();

  assert.deepEqual(errors, []);
  assert.throws(
    () => element.setState("thinking"),
    (error) => error instanceof AvatarError && error.code === "NOT_INITIALIZED",
  );
  element.destroy();
});

test("disconnect destroys the controller; reconnect creates a fresh one", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  const element = connectedCharacterElement();
  await flush();
  const first = getHarness();
  assert.equal(first.renderer.calls.filter((c) => c.method === "initialize").length, 1);

  element.disconnectedCallback();
  assert.equal(first.renderer.destroyed, true);
  assert.equal(first.audio.destroyed, true);

  element.connectedCallback();
  await flush();
  const second = getHarness();
  assert.notEqual(second, first);
  assert.equal(second.renderer.destroyed, false);
  assert.equal(second.renderer.calls.filter((c) => c.method === "initialize").length, 1);
  assert.equal(second.controller.state, "idle");
});

test("autoplay=false does not block initialization and flows into the config", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  const element = new PiAvatarElement();
  element.setAttribute("character", "/characters/demo/manifest.json");
  element.setAttribute("autoplay", "false");
  element.connectedCallback();
  await flush();

  // autoplay is an AvatarConfig field for the controller, not a gate on
  // character initialization (B2 Review #3).
  const harness = getHarness();
  const initializeCall = harness.runtime.calls[0];
  assert.equal(initializeCall.method, "initialize");
  assert.equal(initializeCall.config.autoplay, false);
  assert.equal(harness.renderer.calls.filter((c) => c.method === "initialize").length, 1);
  assert.equal(element.state, "idle");
});

test("character change during initialize loads the latest character (B2 #1)", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  const element = connectedCharacterElement();
  // The character attribute changes while auto-initialization is still in
  // flight; the newer character must win over the one that started first.
  element.setAttribute("character", "/characters/demo/v2/manifest.json");
  await flush();

  const harness = getHarness();
  assert.equal(harness.renderer.calls.filter((c) => c.method === "initialize").length, 1);
  assert.equal(
    harness.runtime.calls[0].config.character,
    "/characters/demo/v2/manifest.json",
  );
  assert.equal(
    harness.renderer.calls[0].input.character.id,
    "/characters/demo/v2/manifest.json",
  );
  assert.equal(element.state, "idle");
});

test("setState during initialize does not throw and applies after init (B2 #2)", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  const element = new PiAvatarElement();
  element.setAttribute("character", "/characters/demo/manifest.json");
  element.connectedCallback();

  // initialize is still in flight; the request must be deferred, not rejected
  // with NOT_INITIALIZED (B2 Review #2).
  element.setState("thinking");
  await flush();

  assert.equal(element.state, "thinking");
  assert.ok(
    getHarness().renderer.calls.some((c) => c.method === "setState" && c.state === "thinking"),
  );
});

test("removing width/height/background clears host and stage inline styles (B2 #4)", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  const element = new PiAvatarElement();
  element.setAttribute("character", "/characters/demo/manifest.json");
  element.setAttribute("width", "320");
  element.setAttribute("height", "480");
  element.setAttribute("background", "#101010");
  element.connectedCallback();
  await flush();

  const stage = getHarness().renderer.calls[0].input.container;
  assert.equal(element.style.width, "320px");
  assert.equal(element.style.height, "480px");
  assert.equal(stage.style.background, "#101010");

  element.removeAttribute("width");
  element.removeAttribute("height");
  element.removeAttribute("background");
  assert.equal(element.style.width, "");
  assert.equal(element.style.height, "");
  assert.equal(stage.style.background, "");
});

test("initialize accepts an explicit parsed character manifest", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  const element = new PiAvatarElement();
  const manifest = {
    id: "custom",
    version: "2.0.0",
    renderer: "rive",
    assetUrl: "/custom.riv",
    stateMachine: "AvatarState",
    inputs: { idle: "idle", audioLevel: "mouthOpen" },
  };
  element.connectedCallback();
  await flush();

  await element.initialize({ character: manifest, background: "#101010" });
  const initCall = getHarness().runtime.calls[0];
  assert.equal(initCall.config.character, manifest);
  assert.equal(initCall.config.background, "#101010");
  assert.equal(getHarness().renderer.calls[0].input.character.id, "custom");
});
