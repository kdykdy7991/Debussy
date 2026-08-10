import { AvatarError } from "../core/index.js";
import type { AvatarConfig, AvatarController } from "../core/index.js";
// Import from pi-avatar.js (not the web-component entry): the entry's module
// load registers <pi-avatar>, which would break ADR-0005's "importing the root
// entry must not register". pi-avatar.js exposes the same symbols without the
// side effect, so registration happens only when createAvatar calls it.
import { registerPiAvatarElement, PiAvatarElement } from "../web-component/pi-avatar.js";

/**
 * Embed options for `createAvatar()` (ADR-0005).
 *
 * `AvatarEmbedOptions` is the full `AvatarConfig`, plus a `target` that selects
 * where the new `<pi-avatar>` element is mounted. `character` may be either a
 * URL string (kept as an attribute) or an already-parsed `CharacterManifest`
 * (passed through `initialize()` instead of being serialized into an
 * attribute).
 */
export interface AvatarEmbedOptions extends AvatarConfig {
  target: string | HTMLElement;
}

/**
 * The handle returned by `createAvatar()` (ADR-0005).
 *
 * `controller` is the public-interface proxy the newly created `<pi-avatar>`
 * element exposes — the same `AvatarController` shape a host would use on the
 * element directly. It is never the internal `CoreAvatarController`
 * implementation class. `ready` settles with the outcome of this instance's
 * initialization; `destroy()` is idempotent and may be called again or after
 * the host has removed the element.
 */
export interface AvatarEmbedHandle {
  readonly element: PiAvatarElement;
  readonly controller: AvatarController;
  readonly ready: Promise<void>;
  destroy(): void;
}

/**
 * Attributes that map 1:1 from `AvatarEmbedOptions` onto the element. The
 * `character` URL string is included; an object `character` is intentionally
 * not (it is passed through `initialize()`).
 */
const ATTRIBUTE_NAMES = [
  "mode",
  "position",
  "width",
  "height",
  "background",
  "autoplay",
] as const;

function isHTMLElement(value: unknown): value is HTMLElement {
  return typeof HTMLElement !== "undefined" && value instanceof HTMLElement;
}

/**
 * Resolve the mount target. A string is read with `document.querySelector`; a
 * missing match, an invalid selector, or a non-`HTMLElement` target is an
 * `INVALID_CONFIG` error. A directly-passed target must also be an
 * `HTMLElement`: JavaScript can bypass TypeScript and pass e.g. a number or an
 * `SVGElementStub`, so the runtime check applies to both branches and throws
 * the contract error rather than a bare `TypeError` (B4 Review #2). In a
 * DOM-less environment `HTMLElement` is undefined, so nothing can be a valid
 * mount target either.
 */
function resolveTarget(target: string | HTMLElement): HTMLElement {
  if (typeof target === "string") {
    let node: Element | null;
    try {
      node = document.querySelector(target);
    } catch {
      throw new AvatarError("INVALID_CONFIG", `Invalid mount selector: ${target}`);
    }
    if (node === null) {
      throw new AvatarError("INVALID_CONFIG", `No element matches mount selector: ${target}`);
    }
    if (!isHTMLElement(node)) {
      throw new AvatarError("INVALID_CONFIG", `Mount target is not an HTMLElement: ${target}`);
    }
    return node;
  }
  if (!isHTMLElement(target)) {
    throw new AvatarError("INVALID_CONFIG", `Mount target is not an HTMLElement: ${target}`);
  }
  return target;
}

/**
 * Create a single `<pi-avatar>` instance and mount it, returning an
 * `AvatarEmbedHandle` (ADR-0005).
 *
 * The Custom Element is registered lazily and safely here — importing the root
 * entry alone never registers it. The element is appended to the target without
 * clearing or replacing the target's existing children. Serializable options
 * become element attributes; an object `character` is passed through
 * `initialize()` so it is not stringified into the DOM.
 */
export function createAvatar(options: AvatarEmbedOptions): AvatarEmbedHandle {
  const mount = resolveTarget(options.target);
  // Guarded registration happens only on demand, when createAvatar is called.
  registerPiAvatarElement();

  const element = new PiAvatarElement();
  for (const name of ATTRIBUTE_NAMES) {
    const value = options[name];
    if (value !== undefined) {
      element.setAttribute(name, String(value));
    }
  }
  if (typeof options.character === "string") {
    element.setAttribute("character", options.character);
  }
  mount.appendChild(element);

  const config: AvatarConfig = { character: options.character };
  if (options.mode !== undefined) config.mode = options.mode;
  if (options.position !== undefined) config.position = options.position;
  if (options.width !== undefined) config.width = options.width;
  if (options.height !== undefined) config.height = options.height;
  if (options.background !== undefined) config.background = options.background;
  if (options.autoplay !== undefined) config.autoplay = options.autoplay;

  const ready = element.initialize(config);

  const destroy = (): void => {
    // The element's own destroy() is idempotent; removing it from the DOM is
    // safe even if the host already moved or removed it.
    element.destroy();
    element.remove();
  };

  return { element, controller: element, ready, destroy };
}