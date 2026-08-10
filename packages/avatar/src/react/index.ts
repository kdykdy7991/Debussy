/**
 * Public entry for the optional React adapter (task B5).
 *
 * Exports the thin `PiAvatar` wrapper and its props. React stays an optional
 * peer dependency — it is never bundled into the package.
 */
export { PiAvatar } from "./pi-avatar.js";
export type { PiAvatarElement, PiAvatarProps } from "./pi-avatar.js";
export { PiAvatar as default } from "./pi-avatar.js";

// Convenience re-exports of the core types handed to event callbacks.
export type {
  AvatarDisplayMode,
  AvatarEventMap,
  AvatarPosition,
  AvatarState,
} from "../core/index.js";