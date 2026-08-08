/**
 * Public entry for the framework-neutral `<pi-avatar>` element.
 *
 * Loading this entry registers the element (guarded against double-loading) and
 * exposes the controller-factory dependency-injection seam. Hosts observe the
 * six standard events directly on the element.
 */
import { registerPiAvatarElement } from "./pi-avatar.js";
export {
  PiAvatarElement,
  registerPiAvatarElement,
  setControllerFactory,
} from "./pi-avatar.js";
export type { AvatarControllerFactory } from "./pi-avatar.js";

// The web-component entry is the only place allowed to define `<pi-avatar>`
// (ADR-0001) and is marked side-effectful in package.json.
registerPiAvatarElement();
