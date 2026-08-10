import assert from "node:assert/strict";
import test from "node:test";

import { createAvatarTestHarness } from "../dist/testing/index.js";
import { flush, installDomShim } from "./helpers/dom-shim.mjs";

// The element module reads globalThis.HTMLElement at load time, so install the
// shim before importing it.
installDomShim();
const { PiAvatarElement, setControllerFactory } = await import(
  "../dist/web-component/index.js"
);

/** Each connect call creates a fresh harness so reconnect is observable. */
function makeFactory() {
  let harness;
  const factory = (container) => {
    harness = createAvatarTestHarness({ container });
    return harness.controller;
  };
  return { factory, getHarness: () => harness };
}

function connectedElement(attributes = {}) {
  const element = new PiAvatarElement();
  element.setAttribute("character", "/characters/demo/manifest.json");
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.connectedCallback();
  return element;
}

function layoutStyle(element) {
  return element.shadowRoot.querySelector("[data-avatar-layout]");
}

function stage(element) {
  return element.shadowRoot.querySelector("[data-avatar-stage]");
}

test("shadow root contains exactly one layout style", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);
  const element = connectedElement();
  await flush();

  const styles = element.shadowRoot._children.filter(
    (child) => child.hasAttribute("data-avatar-layout"),
  );
  assert.equal(styles.length, 1);
  assert.equal(layoutStyle(element).tagName, "STYLE");
});

test("reconnect does not duplicate the layout style", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);
  const element = connectedElement();
  await flush();

  element.disconnectedCallback();
  element.connectedCallback();
  await flush();

  const styles = element.shadowRoot._children.filter(
    (child) => child.hasAttribute("data-avatar-layout"),
  );
  assert.equal(styles.length, 1);
});

test("default mode is inline and default position is bottom-right", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);
  const element = connectedElement();
  await flush();

  assert.equal(stage(element).getAttribute("data-avatar-mode"), "inline");
  assert.equal(stage(element).getAttribute("data-avatar-position"), "bottom-right");
});

test("floating + bottom-right maps canonical attributes", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);
  const element = connectedElement({ mode: "floating", position: "bottom-right" });
  await flush();

  assert.equal(stage(element).getAttribute("data-avatar-mode"), "floating");
  assert.equal(stage(element).getAttribute("data-avatar-position"), "bottom-right");
});

test("floating + bottom-left maps canonical attributes", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);
  const element = connectedElement({ mode: "floating", position: "bottom-left" });
  await flush();

  assert.equal(stage(element).getAttribute("data-avatar-mode"), "floating");
  assert.equal(stage(element).getAttribute("data-avatar-position"), "bottom-left");
});

test("switching inline/floating does not rebuild the controller", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  const element = connectedElement();
  await flush();
  const harness = getHarness();
  assert.equal(harness.renderer.calls.filter((c) => c.method === "initialize").length, 1);

  element.setAttribute("mode", "floating");
  await flush();
  element.setAttribute("mode", "inline");
  await flush();

  assert.equal(getHarness(), harness, "controller must be the same instance");
  assert.equal(harness.renderer.destroyed, false);
  assert.equal(harness.renderer.calls.filter((c) => c.method === "initialize").length, 1);
  assert.equal(stage(element).getAttribute("data-avatar-mode"), "inline");
});

test("switching bottom-left/bottom-right does not rebuild the controller", async () => {
  const { factory, getHarness } = makeFactory();
  setControllerFactory(factory);
  const element = connectedElement({ mode: "floating" });
  await flush();
  const harness = getHarness();

  element.setAttribute("position", "bottom-left");
  await flush();
  assert.equal(stage(element).getAttribute("data-avatar-position"), "bottom-left");

  element.setAttribute("position", "bottom-right");
  await flush();

  assert.equal(getHarness(), harness, "controller must be the same instance");
  assert.equal(harness.renderer.destroyed, false);
  assert.equal(stage(element).getAttribute("data-avatar-position"), "bottom-right");
});

test("invalid mode/position fall back to canonical defaults", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);
  const element = connectedElement({ mode: "sideways", position: "top-left" });
  await flush();

  assert.equal(stage(element).getAttribute("data-avatar-mode"), "inline");
  assert.equal(stage(element).getAttribute("data-avatar-position"), "bottom-right");
});

test("layout CSS defines the five frozen custom properties with defaults", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);
  const element = connectedElement();
  await flush();

  const css = layoutStyle(element).textContent;
  assert.match(css, /--pi-avatar-width:\s*320px/);
  assert.match(css, /--pi-avatar-height:\s*480px/);
  assert.match(css, /--pi-avatar-z-index:\s*1000/);
  assert.match(css, /--pi-avatar-offset-x:\s*16px/);
  assert.match(css, /--pi-avatar-offset-y:\s*16px/);
});

test("layout CSS contains safe-area and dynamic viewport constraints", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);
  const element = connectedElement();
  await flush();

  const css = layoutStyle(element).textContent;
  assert.match(css, /env\(safe-area-inset-(?:left|right|bottom)\)/);
  assert.match(css, /100dvh/);
  assert.match(css, /100vh/);
  assert.match(css, /max-width:\s*100vw/);
});

test("width/height/background attributes style the host and stage", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);
  const element = connectedElement({
    width: "400",
    height: "600",
    background: "#101010",
  });
  await flush();

  // Sizes land on the host so they override the CSS custom properties and do
  // not compound onto the stage (B3 Review #1).
  assert.equal(element.style.width, "400px");
  assert.equal(element.style.height, "600px");
  assert.equal(stage(element).style.background, "#101010");

  element.removeAttribute("width");
  element.removeAttribute("height");
  element.removeAttribute("background");
  assert.equal(element.style.width, "");
  assert.equal(element.style.height, "");
  assert.equal(stage(element).style.background, "");
});

test("percentage width is not compounded onto the stage (B3 Review #1)", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);
  const element = connectedElement({ width: "50%", height: "50%" });
  await flush();

  // The stage must keep its CSS `width: 100%; height: 100%` fill; only the
  // host carries the attribute size, otherwise 50% on both would shrink the
  // stage to 25% of the container.
  assert.equal(element.style.width, "50%");
  assert.equal(element.style.height, "50%");
  // No inline width/height on the stage: it keeps its CSS `width: 100%;
  // height: 100%` fill, so the percentage never compounds (50% of 50%).
  assert.equal(stage(element).style.width, undefined);
  assert.equal(stage(element).style.height, undefined);
});

test("floating max-size CSS reserves offsets and safe areas (B3 Review #2)", async () => {
  const { factory } = makeFactory();
  setControllerFactory(factory);
  const element = connectedElement();
  await flush();

  const css = layoutStyle(element).textContent;
  // A fixed 320px host inset by 16px on a 320px viewport would overflow the
  // opposite edge; floating max-size must subtract the configured offsets and
  // safe-area insets, keeping the 100vh/100dvh fallback chain.
  assert.match(css, /:host\(\[mode="floating"\]\)/);
  assert.match(
    css,
    /max-width:\s*calc\([\s\S]*var\(--pi-avatar-offset-x\)\s*\*\s*2[\s\S]*env\(safe-area-inset-left\)[\s\S]*env\(safe-area-inset-right\)[\s\S]*\)/,
  );
  assert.match(
    css,
    /max-height:\s*calc\([\s\S]*var\(--pi-avatar-offset-y\)\s*\*\s*2[\s\S]*env\(safe-area-inset-top\)[\s\S]*env\(safe-area-inset-bottom\)[\s\S]*\)/,
  );
  // The dvh variant follows the 100vh fallback declaration (B3 §4.4).
  assert.ok(css.indexOf("max-height: calc(\n      100dvh") > -1);
  assert.ok(css.indexOf("max-height: calc(\n      100vh") > -1);
});
