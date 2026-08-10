/**
 * React adapter tests for task B5.
 *
 * These run under `node --test` with jsdom (the custom dom-shim is too minimal
 * for React DOM rendering). They import the *built* `dist/` output like every
 * other test file, and use the real controller-factory harness so the
 * `<pi-avatar>` element initializes against a fake renderer/audio/runtime.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";

import { createAvatarTestHarness } from "../dist/testing/index.js";
import { flush } from "./helpers/dom-shim.mjs";

/** React 18+ createRoot commits asynchronously; poll until the tree settles. */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// Install jsdom globals before importing the web-component module, which reads
// global HTMLElement / customElements at module-evaluation time.
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
for (const key of [
  "document",
  "HTMLElement",
  "customElements",
  "CustomEvent",
  "Event",
  "EventTarget",
  "Node",
]) {
  globalThis[key] = window[key];
}

const { PiAvatarElement, setControllerFactory } = await import(
  "../dist/web-component/index.js"
);
const { PiAvatar } = await import("../dist/react/index.js");

/** Each render drives a fresh harness so mount/unmount is observable. */
function makeFactory() {
  let harness;
  const factory = (container) => {
    harness = createAvatarTestHarness({ container });
    return harness.controller;
  };
  return { factory, getHarness: () => harness };
}

/** Render a tree into a fresh root and return {root, container, element}. */
function mount(render) {
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(render);
  return { root, container };
}

async function flushAndFind(container) {
  await settle();
  return container.querySelector("pi-avatar");
}

test("renders a single <pi-avatar> and maps serializable props to attributes", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);

  const { root, container } = mount(
    React.createElement(PiAvatar, {
      character: "/characters/demo/manifest.json",
      state: "speaking",
      mode: "floating",
      position: "bottom-left",
      width: 320,
      height: "50vh",
      background: "#101010",
      autoplay: false,
      id: "avatar-1",
      className: "my-avatar",
      "aria-label": "Demo assistant",
    }),
  );

  const element = await flushAndFind(container);
  assert.ok(element, "pi-avatar element should be rendered");
  assert.ok(element instanceof PiAvatarElement);
  assert.equal(element.getAttribute("character"), "/characters/demo/manifest.json");
  assert.equal(element.getAttribute("state"), "speaking");
  assert.equal(element.getAttribute("mode"), "floating");
  assert.equal(element.getAttribute("position"), "bottom-left");
  // Numbers become CSS pixel lengths; strings (including "50vh") pass through.
  assert.equal(element.getAttribute("width"), "320px");
  assert.equal(element.getAttribute("height"), "50vh");
  assert.equal(element.getAttribute("background"), "#101010");
  // false autoplay must be expressed as the recognizable "false" attribute.
  assert.equal(element.getAttribute("autoplay"), "false");
  assert.equal(element.getAttribute("id"), "avatar-1");
  assert.equal(element.getAttribute("class"), "my-avatar");
  assert.equal(element.getAttribute("aria-label"), "Demo assistant");

  root.unmount();
});

test("autoplay true is the bare attribute, false is \"false\", absent removes it", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);

  const mutate = async (props) => {
    const { root, container } = mount(
      React.createElement(PiAvatar, { character: "/c.json", ...props }),
    );
    const element = await flushAndFind(container);
    return { root, element };
  };

  let { root, element } = await mutate({ autoplay: true });
  assert.equal(element.getAttribute("autoplay"), "");
  root.unmount();

  ({ root, element } = await mutate({ autoplay: false }));
  assert.equal(element.getAttribute("autoplay"), "false");
  root.unmount();

  ({ root, element } = await mutate({}));
  assert.equal(element.hasAttribute("autoplay"), false);
  root.unmount();
});

test("props updates mutate attributes without recreating the element", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);

  const { root, container } = mount(
    React.createElement(PiAvatar, { character: "/c.json", background: "red" }),
  );

  const element = await flushAndFind(container);
  assert.equal(element.getAttribute("background"), "red");

  // Update background, add height.
  root.render(
    React.createElement(PiAvatar, {
      character: "/c.json",
      background: "blue",
      height: 200,
    }),
  );
  await settle();
  assert.equal(element.getAttribute("background"), "blue");
  assert.equal(element.getAttribute("height"), "200px");

  // Removing the optional prop removes the attribute (no stale value).
  root.render(React.createElement(PiAvatar, { character: "/c.json" }));
  await settle();
  assert.equal(element.hasAttribute("background"), false);
  assert.equal(element.hasAttribute("height"), false);

  root.unmount();
});

test("state update forwards through the controller to the renderer", async () => {
  const harnesses = [];
  const factory = (container) => {
    const harness = createAvatarTestHarness({ container });
    harnesses.push(harness);
    return harness.controller;
  };
  setControllerFactory(factory);

  const live = () => harnesses.filter((h) => !h.renderer.destroyed);

  const { root } = mount(React.createElement(PiAvatar, { character: "/c.json" }));
  await settle();
  // idle is the controller default, so no setState fires until a real change.
  assert.equal(live().length, 1);
  assert.equal(live()[0].renderer.calls.some((c) => c.method === "setState"), false);

  // Adding a non-default state propagates to the element and the controller.
  root.render(React.createElement(PiAvatar, { character: "/c.json", state: "thinking" }));
  await settle();
  assert.equal(live()[0].renderer.calls.some((c) => c.method === "setState" && c.state === "thinking"), true);

  root.unmount();
});

test("character change re-initializes per B2 semantics, not a new node", async () => {
  const harnesses = [];
  const factory = (container) => {
    const harness = createAvatarTestHarness({ container });
    harnesses.push(harness);
    return harness.controller;
  };
  setControllerFactory(factory);

  const initializes = () =>
    harnesses.reduce(
      (n, h) => n + h.renderer.calls.filter((c) => c.method === "initialize").length,
      0,
    );

  const { root, container } = mount(
    React.createElement(PiAvatar, { character: "/a.json" }),
  );
  const element = await flushAndFind(container);
  // The active controller has initialized exactly once (the pre-attribute
  // stub controller created on connect is destroyed when `character` lands).
  assert.equal(initializes(), 1);
  const activeAfterMount = harnesses.find((h) => !h.renderer.destroyed);
  assert.ok(activeAfterMount, "a live controller should exist after mount");

  root.render(React.createElement(PiAvatar, { character: "/b.json" }));
  await settle();
  assert.equal(element.getAttribute("character"), "/b.json");
  // The element is reused; the controller re-initialized (B2 latest-wins).
  assert.equal(container.querySelector("pi-avatar"), element);
  // A fresh controller was created and initialized for the new character.
  assert.equal(initializes(), 2);
  const activeAfterChange = harnesses.find((h) => !h.renderer.destroyed);
  assert.notEqual(activeAfterChange, activeAfterMount, "controller should be recreated");

  root.unmount();
});

test("six event callbacks fire with the public detail on the element", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);

  const fired = [];
  const cat = (name) => (detail) => fired.push([name, detail]);

  const { root, container } = mount(
    React.createElement(PiAvatar, {
      character: "/c.json",
      onAvatarReady: cat("ready"),
      onAvatarStateChange: cat("state"),
      onAvatarSpeechStart: cat("speech-start"),
      onAvatarSpeechEnd: cat("speech-end"),
      onAvatarError: cat("error"),
      onAvatarInterrupted: cat("interrupted"),
    }),
  );
  const element = await flushAndFind(container);

  element.dispatchEvent(new window.CustomEvent("avatar-ready", { detail: { manifestUrl: "/c.json" } }));
  element.dispatchEvent(new window.CustomEvent("avatar-state-change", { detail: { previous: "idle", current: "thinking" } }));
  element.dispatchEvent(new window.CustomEvent("avatar-speech-start", { detail: { audioUrl: "/a.wav" } }));
  element.dispatchEvent(new window.CustomEvent("avatar-speech-end", { detail: { audioUrl: "/a.wav", reason: "completed" } }));
  element.dispatchEvent(new window.CustomEvent("avatar-error", { detail: { code: "LOAD_FAILED", message: "boom" } }));
  element.dispatchEvent(new window.CustomEvent("avatar-interrupted", { detail: { source: "host" } }));

  assert.deepEqual(fired, [
    ["ready", { manifestUrl: "/c.json" }],
    ["state", { previous: "idle", current: "thinking" }],
    ["speech-start", { audioUrl: "/a.wav" }],
    ["speech-end", { audioUrl: "/a.wav", reason: "completed" }],
    ["error", { code: "LOAD_FAILED", message: "boom" }],
    ["interrupted", { source: "host" }],
  ]);

  root.unmount();
});

test("callback updates call the latest handler without re-registering listeners", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);

  const calls = [];
  let handler = (d) => calls.push(["first", d]);

  const { root, container } = mount(
    React.createElement(PiAvatar, { character: "/c.json", onAvatarReady: handler }),
  );
  const element = await flushAndFind(container);

  element.dispatchEvent(new window.CustomEvent("avatar-ready", { detail: { n: 1 } }));
  assert.deepEqual(calls, [["first", { n: 1 }]]);

  handler = (d) => calls.push(["second", d]);
  root.render(React.createElement(PiAvatar, { character: "/c.json", onAvatarReady: handler }));
  await settle();

  element.dispatchEvent(new window.CustomEvent("avatar-ready", { detail: { n: 2 } }));
  assert.deepEqual(calls, [
    ["first", { n: 1 }],
    ["second", { n: 2 }],
  ]);

  root.unmount();
});

test("ref forwards to the real PiAvatarElement and exposes controller methods", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);

  const ref = React.createRef();
  const { root, container } = mount(
    React.createElement(PiAvatar, { character: "/c.json", ref }),
  );
  const element = await flushAndFind(container);

  assert.ok(ref.current, "ref should be populated");
  assert.equal(ref.current, element);
  assert.ok(ref.current instanceof PiAvatarElement);

  for (const method of ["setState", "speak", "stopSpeaking", "interrupt", "show", "hide", "destroy", "setAudioLevel", "initialize"]) {
    assert.equal(typeof ref.current[method], "function", `ref should expose ${method}`);
  }

  root.unmount();
});

test("unmount destroys the controller and clears the ref", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);

  const ref = React.createRef();
  const { root, container } = mount(
    React.createElement(PiAvatar, { character: "/c.json", ref }),
  );
  await flushAndFind(container);
  const harness = getHarness();
  assert.equal(harness.renderer.destroyed, false);

  root.unmount();
  await settle();
  assert.equal(harness.renderer.destroyed, true);
  assert.equal(harness.audio.destroyed, true);
  assert.equal(ref.current, null, "ref must be null after unmount");
  assert.equal(container.childNodes.length, 0);
});

test("porting-level destroy is idempotent and safe", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);

  const ref = React.createRef();
  const { root } = mount(React.createElement(PiAvatar, { character: "/c.json", ref }));
  await settle();
  const harness = getHarness();

  ref.current.destroy();
  ref.current.destroy();
  assert.equal(harness.renderer.destroyed, true);

  root.unmount();
});

test("two <PiAvatar> instances stay independent in one tree", async () => {
  const harnesses = [];
  const factory = (container) => {
    const harness = createAvatarTestHarness({ container });
    harnesses.push(harness);
    return harness.controller;
  };
  setControllerFactory(factory);

  const { root, container } = mount(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(PiAvatar, { character: "/a.json", background: "red" }),
      React.createElement(PiAvatar, { character: "/b.json", background: "blue" }),
    ),
  );
  await settle();

  const elements = container.querySelectorAll("pi-avatar");
  assert.equal(elements.length, 2);
  // Each connect creates a stub controller until `character` lands, so more
  // harnesses are produced than live at the end; exactly one per element lives.
  const live = harnesses.filter((h) => !h.renderer.destroyed);
  assert.equal(live.length, 2);
  for (const h of live) {
    assert.equal(h.renderer.calls.filter((c) => c.method === "initialize").length, 1);
  }
  // Attributes are per-element, not cross-contaminated.
  assert.equal(elements[0].getAttribute("background"), "red");
  assert.equal(elements[1].getAttribute("background"), "blue");

  // Unmounting one instance must not tear down the other.
  root.render(
    React.createElement(PiAvatar, { character: "/b.json", background: "blue" }),
  );
  await settle();
  assert.equal(container.querySelectorAll("pi-avatar").length, 1);
  assert.equal(harnesses[0].renderer.destroyed, true, "removed instance is destroyed");
  const remaining = harnesses.filter((h) => !h.renderer.destroyed);
  assert.equal(remaining.length, 1, "exactly one instance survives");
  assert.equal(remaining[0].renderer.calls.filter((c) => c.method === "initialize").length, 1);

  root.unmount();
});

test("StrictMode double-invokes effects without leaking or double initializing", async () => {
  const harnesses = [];
  const factory = (container) => {
    const harness = createAvatarTestHarness({ container });
    harnesses.push(harness);
    return harness.controller;
  };
  setControllerFactory(factory);

  const { root, container } = mount(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(PiAvatar, { character: "/c.json" }),
    ),
  );
  await settle();

  const elements = container.querySelectorAll("pi-avatar");
  assert.equal(elements.length, 1);
  // StrictMode simulates mount/unmount/mount for effects; the element must
  // survive and end up with exactly one live controller.
  const live = harnesses.filter((h) => !h.renderer.destroyed);
  assert.equal(live.length, 1, "exactly one live controller after StrictMode cycle");
  assert.equal(live[0].renderer.calls.filter((c) => c.method === "initialize").length, 1);

  root.unmount();
});