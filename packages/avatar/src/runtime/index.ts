import { CoreAvatarController } from "../core/controller.js";
import type { AvatarController } from "../core/types.js";
import {
  VisualAvatarRuntime,
  type VisualAvatarRuntimeDependencies,
} from "./visual-avatar-runtime.js";

/** Internal production factory consumed by the Web Component adapter. */
export function createVisualAvatarController(
  container: HTMLElement,
  dependencies?: VisualAvatarRuntimeDependencies,
): AvatarController {
  return new CoreAvatarController(new VisualAvatarRuntime(container, dependencies));
}

export {
  VisualAvatarRuntime,
  defaultVisualAvatarRuntimeDependencies,
  type VisualAvatarRuntimeDependencies,
  type VisualResizeObserver,
} from "./visual-avatar-runtime.js";
