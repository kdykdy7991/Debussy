import assert from "node:assert/strict";
import test from "node:test";

import { createAvatarTestHarness } from "../dist/testing/index.js";
import { flush, installDomShim } from "./helpers/dom-shim.mjs";
import { makeFactory } from "./helpers/harness.mjs";

// The embed module reads customElements/document at call time; the shim must be
// installed before importing the built root entry (which loads the web-component
// module that references HTMLElement at module top level).
installDomShim();

const { PiAvatarElement, setControllerFactory } = await import(
  "../dist/web-component/index.js"
);
const { AvatarError, createAvatar } = await import("../dist/index.js");

const MANIFEST = {
  id: "custom",
  version: "2.0.0",
  renderer: "rive",
  assetUrl: "/custom.riv",
  stateMachine: "AvatarState",
  inputs: { idle: "idle", audioLevel: "mouthOpen" },
};

test("createAvatar registers the element lazily and safely on first call", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);
  await flush();

  const mount = document.createElement("div");
  const handle = createAvatar({ target: mount, character: "/demo.json" });
  await handle.ready;

  assert.equal(customElements.get("pi-avatar"), PiAvatarElement);
  // A second (duplicate) call must not throw: the guard keeps one definition.
  assert.doesNotThrow(() => createAvatar({ target: mount, character: "/demo.json" }));
});

test("string target resolved via querySelector and mounted", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  await flush();

  const mount = document.createElement("div");
  mount.setAttribute("id", "host");
  document.body.appendChild(mount);

  const handle = createAvatar({ target: "#host", character: "/demo.json" });
  await handle.ready;

  assert.equal(mount.children.length, 1);
  assert.equal(mount.children[0], handle.element);
  assert.equal(getHarness().renderer.calls.filter((c) => c.method === "initialize").length, 1);
});

test("HTMLElement target is used directly and existing children preserved", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  await flush();

  const mount = document.createElement("div");
  const existing = document.createElement("span");
  mount.appendChild(existing);

  const handle = createAvatar({ target: mount, character: "/demo.json" });
  await handle.ready;

  assert.equal(mount.children.length, 2);
  assert.equal(mount.children[0], existing);
  assert.equal(mount.children[1], handle.element);
});

test("invalid string target throws INVALID_CONFIG", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);
  await flush();

  assert.throws(
    () => createAvatar({ target: "#missing", character: "/demo.json" }),
    (error) => error instanceof AvatarError && error.code === "INVALID_CONFIG",
  );
  assert.throws(
    () => createAvatar({ target: "(", character: "/demo.json" }),
    (error) => error instanceof AvatarError && error.code === "INVALID_CONFIG",
  );
});

test("selector matching a non-HTMLElement throws INVALID_CONFIG", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);
  await flush();

  const svg = document.createElement("svg");
  svg.setAttribute("id", "not-html");
  document.body.appendChild(svg);

  assert.throws(
    () => createAvatar({ target: "#not-html", character: "/demo.json" }),
    (error) => error instanceof AvatarError && error.code === "INVALID_CONFIG",
  );
});

test("direct non-HTMLElement target throws INVALID_CONFIG, not a TypeError", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);
  await flush();

  // JavaScript can bypass TypeScript and pass an arbitrary value directly.
  for (const bad of [42, "not-a-mount", null, undefined, {}, true]) {
    assert.throws(
      () => createAvatar({ target: bad, character: "/demo.json" }),
      (error) => error instanceof AvatarError && error.code === "INVALID_CONFIG",
      `target ${String(bad)} should throw INVALID_CONFIG`,
    );
  }

  // A non-HTMLElement DOM node (SVG) passed directly is also rejected.
  const svg = document.createElement("svg");
  assert.throws(
    () => createAvatar({ target: svg, character: "/demo.json" }),
    (error) => error instanceof AvatarError && error.code === "INVALID_CONFIG",
  );
});

test("serializable options map to element attributes", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  await flush();

  const mount = document.createElement("div");
  const handle = createAvatar({
    target: mount,
    character: "/demo.json",
    mode: "floating",
    position: "bottom-left",
    width: 320,
    height: 480,
    background: "#101010",
    autoplay: false,
  });
  await handle.ready;

  const element = handle.element;
  assert.equal(element.getAttribute("character"), "/demo.json");
  assert.equal(element.getAttribute("mode"), "floating");
  assert.equal(element.getAttribute("position"), "bottom-left");
  assert.equal(element.getAttribute("width"), "320");
  assert.equal(element.getAttribute("height"), "480");
  assert.equal(element.getAttribute("background"), "#101010");
  assert.equal(element.getAttribute("autoplay"), "false");

  const initConfig = getHarness().runtime.calls[0].config;
  assert.equal(initConfig.mode, "floating");
  assert.equal(initConfig.position, "bottom-left");
  assert.equal(initConfig.width, 320);
  assert.equal(initConfig.height, 480);
  assert.equal(initConfig.background, "#101010");
  assert.equal(initConfig.autoplay, false);
});

test("object character is passed via initialize, not serialized to an attribute", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  await flush();

  const mount = document.createElement("div");
  const handle = createAvatar({ target: mount, character: MANIFEST });
  await handle.ready;

  assert.equal(handle.element.hasAttribute("character"), false);
  assert.equal(getHarness().runtime.calls[0].config.character, MANIFEST);
  assert.equal(getHarness().renderer.calls[0].input.character, MANIFEST);
});

test("ready resolves on successful initialization", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);
  await flush();

  const mount = document.createElement("div");
  const handle = createAvatar({ target: mount, character: "/demo.json" });

  let settled = false;
  handle.ready.then(() => (settled = true));
  await handle.ready;
  assert.equal(settled, true);
});

test("ready rejects on initialization failure and keeps the element", async () => {
  installDomShim();
  const { setControllerFactory: setFactory } = await import(
    "../dist/web-component/index.js"
  );
  const { createAvatar: create } = await import("../dist/index.js");
  setFactory((container) => {
    const renderer = {
      initialize() {
        throw new Error("boom");
      },
      setState() {},
      setAudioLevel() {},
      resize() {},
      destroy() {},
    };
    return createAvatarTestHarness({ container, renderer }).controller;
  });
  await flush();

  const mount = document.createElement("div");
  const handle = create({ target: mount, character: "/demo.json" });
  await assert.rejects(handle.ready);

  // The element stays mounted so the host can read state and destroy it.
  assert.equal(mount.children.length, 1);
  assert.equal(mount.children[0], handle.element);
});

test("speak forwards through the controller proxy and speech events flow", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  await flush();

  const mount = document.createElement("div");
  const handle = createAvatar({ target: mount, character: "/demo.json" });
  await handle.ready;

  const events = [];
  handle.controller.addEventListener("avatar-speech-start", (e) => events.push(["start", e.detail]));
  handle.controller.addEventListener("avatar-speech-end", (e) => events.push(["end", e.detail]));

  const speaking = handle.controller.speak({ audioUrl: "/answer.wav" });
  await flush();
  assert.equal(getHarness().audio.hasActiveSpeech, true);
  getHarness().audio.finishSpeech("completed");
  await speaking;

  assert.deepEqual(events, [
    ["start", { audioUrl: "/answer.wav" }],
    ["end", { audioUrl: "/answer.wav", reason: "completed" }],
  ]);
});

test("controller exposes the public proxy surface and events forward unchanged", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  await flush();

  const mount = document.createElement("div");
  const handle = createAvatar({ target: mount, character: "/demo.json" });
  await handle.ready;

  const events = [];
  handle.controller.addEventListener("avatar-state-change", (e) => events.push(e.detail));

  handle.controller.setState("thinking");
  assert.equal(handle.element.state, "thinking");
  assert.deepEqual(events, [{ previous: "idle", current: "thinking" }]);

  handle.controller.interrupt();
  const interrupted = [];
  handle.controller.addEventListener("avatar-interrupted", (e) => interrupted.push(e.detail));
  handle.controller.interrupt();
  assert.deepEqual(interrupted, [{ source: "host" }]);

  // The proxy is the element's own public interface, not an internal class.
  assert.equal(handle.controller, handle.element);
});

test("destroy is idempotent and removes the SDK-created element", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  await flush();

  const mount = document.createElement("div");
  const handle = createAvatar({ target: mount, character: "/demo.json" });
  await handle.ready;
  const harness = getHarness();

  handle.destroy();
  handle.destroy();

  assert.equal(harness.renderer.destroyed, true);
  assert.equal(harness.audio.destroyed, true);
  assert.equal(mount.children.length, 0);
});

test("destroy is safe when the host already removed the element", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  await flush();

  const mount = document.createElement("div");
  const handle = createAvatar({ target: mount, character: "/demo.json" });
  await handle.ready;
  const harness = getHarness();

  // Host removes the element out from under the SDK.
  mount.removeChild(handle.element);
  assert.equal(mount.children.length, 0);

  assert.doesNotThrow(() => handle.destroy());
  assert.equal(harness.renderer.destroyed, true);
});

test("a new instance can be created after destroy", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  await flush();

  const mount = document.createElement("div");
  const first = createAvatar({ target: mount, character: "/demo.json" });
  await first.ready;
  first.destroy();
  assert.equal(mount.children.length, 0);

  const second = createAvatar({ target: mount, character: "/demo.json" });
  await second.ready;
  const harness = getHarness();
  assert.equal(mount.children.length, 1);
  assert.notEqual(second.element, first.element);
  assert.equal(harness.renderer.destroyed, false);
  assert.equal(harness.renderer.calls.filter((c) => c.method === "initialize").length, 1);
});

test("multiple instances on the same target are isolated", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  await flush();

  const mount = document.createElement("div");
  const a = createAvatar({ target: mount, character: "/a.json" });
  const b = createAvatar({ target: mount, character: "/b.json" });
  await Promise.all([a.ready, b.ready]);

  assert.equal(mount.children.length, 2);
  assert.notEqual(a.element, b.element);

  a.destroy();
  assert.equal(mount.children.length, 1);
  assert.equal(mount.children[0], b.element);
  assert.equal(getHarness().renderer.destroyed, false);

  b.destroy();
  assert.equal(mount.children.length, 0);
});