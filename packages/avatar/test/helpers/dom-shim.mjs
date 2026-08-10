/**
 * Minimal DOM shim for component tests under `node --test`.
 *
 * Node ships no DOM, so this installs just enough of `HTMLElement`,
 * `ShadowRoot`, `document` and `customElements` for the `<pi-avatar>` element
 * to run its attribute mapping, method proxying and lifecycle logic. It is
 * deliberately small: attribute storage, a single shadow root, a stage lookup
 * and a custom-element registry.
 *
 * Test-only; never imported by `src/**`.
 */

class ElementStub extends EventTarget {
  constructor(tag = "div") {
    super();
    this.tagName = tag.toUpperCase();
    this._attributes = new Map();
    this._children = [];
    this._shadowRoot = undefined;
    this.style = {};
  }

  getAttribute(name) {
    return this._attributes.has(name) ? this._attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this._attributes.has(name);
  }

  setAttribute(name, value) {
    const old = this._attributes.has(name) ? this._attributes.get(name) : null;
    this._attributes.set(name, String(value));
    this._notifyAttributeChanged(name, old, String(value));
  }

  removeAttribute(name) {
    if (!this._attributes.has(name)) {
      return;
    }
    const old = this._attributes.get(name);
    this._attributes.delete(name);
    this._notifyAttributeChanged(name, old, null);
  }

  attachShadow({ mode }) {
    if (this._shadowRoot) {
      throw new Error("Shadow root already attached");
    }
    this._shadowRoot = new ShadowRootStub(this, mode);
    return this._shadowRoot;
  }

  get shadowRoot() {
    return this._shadowRoot;
  }

  appendChild(child) {
    this._children.push(child);
    child._setParentNode?.(this);
    return child;
  }

  /** Live view of appended children (used by embed mount/destroy tests). */
  get children() {
    return this._children;
  }

  removeChild(child) {
    this._children = this._children.filter((existing) => existing !== child);
    return child;
  }

  matches(selector) {
    if (selector === "[data-avatar-stage]") {
      return this.hasAttribute("data-avatar-stage");
    }
    if (selector === "[data-avatar-layout]") {
      return this.hasAttribute("data-avatar-layout");
    }
    return false;
  }

  /** Minimal text content for the layout `<style>` node (task B3). */
  get textContent() {
    return this._textContent ?? "";
  }

  set textContent(value) {
    this._textContent = String(value);
  }

  /** Remove this element from its (shadow) parent, if any (task B4 destroy). */
  remove() {
    const parent = this._parentNode;
    parent?.removeChild(this);
  }

  _setParentNode(parent) {
    this._parentNode = parent;
  }

  _notifyAttributeChanged(name, oldValue, newValue) {
    const observed = this.constructor.observedAttributes;
    if (observed && observed.includes(name)) {
      this.attributeChangedCallback?.(name, oldValue, newValue);
    }
  }
}

class ShadowRootStub {
  constructor(host, mode) {
    this.host = host;
    this.mode = mode;
    this._children = [];
  }

  appendChild(child) {
    this._children.push(child);
    child._setParentNode?.(this);
    return child;
  }

  removeChild(child) {
    this._children = this._children.filter((existing) => existing !== child);
    child._setParentNode?.(undefined);
    return child;
  }

  querySelector(selector) {
    return this._children.find((child) => child.matches?.(selector)) ?? null;
  }
}

/** Non-HTML element (e.g. SVG) for selector-mismatch tests. */
class SVGElementStub extends EventTarget {
  constructor(tag = "svg") {
    super();
    this.tagName = tag.toUpperCase();
    this._attributes = new Map();
  }

  getAttribute(name) {
    return this._attributes.has(name) ? this._attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this._attributes.set(name, String(value));
  }
}

/** Document-wide registry so querySelector can resolve #id / tag selectors. */
const elements = [];

class CustomElementRegistryStub {
  constructor() {
    this._registry = new Map();
  }

  define(name, constructor) {
    if (this._registry.has(name)) {
      throw new Error(`Custom element already defined: ${name}`);
    }
    this._registry.set(name, constructor);
  }

  get(name) {
    return this._registry.get(name);
  }
}

/** Install the shim globals once; subsequent calls are no-ops. */
export function installDomShim() {
  if (globalThis.document) {
    return;
  }
  globalThis.HTMLElement = ElementStub;
  globalThis.SVGElement = SVGElementStub;
  const body = new ElementStub("body");
  elements.push(body);
  globalThis.document = {
    body,
    createElement: (tag) => {
      const element = tag.toLowerCase() === "svg" ? new SVGElementStub() : new ElementStub(tag);
      elements.push(element);
      return element;
    },
    querySelector: (selector) => {
      if (selector.startsWith("#")) {
        return elements.find((el) => el.getAttribute?.("id") === selector.slice(1)) ?? null;
      }
      return elements.find((el) => el.tagName === selector.toUpperCase()) ?? null;
    },
  };
  globalThis.customElements = new CustomElementRegistryStub();
}

/** Flush pending microtasks/macrotasks so async controller init settles. */
export function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
