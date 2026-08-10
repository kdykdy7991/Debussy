import assert from "node:assert/strict";
import test from "node:test";

// B4 Review #1: the @skdy/avatar root entry must be importable in a DOM-less
// Node/SSR environment without throwing ReferenceError: HTMLElement is not
// defined. This file deliberately does NOT install the DOM shim, and imports
// nothing that would. Each test file runs in its own process, so the globals
// are genuinely absent here.
const { AvatarError, createAvatar } = await import("../dist/index.js");

test("root entry imports cleanly with no DOM globals", () => {
  assert.equal(typeof createAvatar, "function");
  assert.equal(typeof AvatarError, "function");
  assert.equal(typeof globalThis.HTMLElement, "undefined");
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(typeof globalThis.customElements, "undefined");
});

test("createAvatar is callable-shaped without a DOM but target validation still guards", () => {
  // Without a DOM, a string target cannot be resolved; the contract error must
  // still surface as an AvatarError rather than a ReferenceError from
  // document.querySelector. A non-HTMLElement direct target likewise throws the
  // contract error.
  assert.throws(
    () => createAvatar({ target: 42, character: "/demo.json" }),
    (error) => error instanceof AvatarError && error.code === "INVALID_CONFIG",
  );
});