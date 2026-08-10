import assert from "node:assert/strict";
import test from "node:test";

import { installDomShim } from "./helpers/dom-shim.mjs";

// ADR-0005: importing the @skdy/avatar root entry must NOT register <pi-avatar>.
// This file deliberately imports ONLY the root entry (plus the shim), not the
// web-component entry, so the registry stays clean. node --test runs each file
// in its own process, so the registry is fresh here.
installDomShim();

const { createAvatar } = await import("../dist/index.js");
// Import the module (not the web-component ENTRY) so we can configure the
// controller factory WITHOUT the entry's register side effect.
const { setControllerFactory } = await import("../dist/web-component/pi-avatar.js");
import { createAvatarTestHarness } from "../dist/testing/index.js";

test("importing the root entry does not register <pi-avatar>", () => {
  assert.equal(customElements.get("pi-avatar"), undefined);
});

test("createAvatar registers the element lazily on first call", () => {
  assert.equal(customElements.get("pi-avatar"), undefined);
  setControllerFactory((container) => createAvatarTestHarness({ container }).controller);

  const mount = document.createElement("div");
  const handle = createAvatar({ target: mount, character: "/demo.json" });

  // Registration happened synchronously inside createAvatar, before ready.
  assert.equal(customElements.get("pi-avatar"), handle.element.constructor);
});