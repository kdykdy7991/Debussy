import assert from "node:assert/strict";
import test from "node:test";

import { installDomShim } from "./helpers/dom-shim.mjs";

installDomShim();

// A host page that already defined <pi-avatar> (e.g. double-loaded SDK) must
// not have its definition replaced by a later import of the entry.
class ExistingDefinition {}
customElements.define("pi-avatar", ExistingDefinition);

const { PiAvatarElement } = await import("../dist/web-component/index.js");

test("importing the entry does not clobber an existing <pi-avatar> definition", () => {
  assert.equal(customElements.get("pi-avatar"), ExistingDefinition);
  assert.notEqual(customElements.get("pi-avatar"), PiAvatarElement);
});
