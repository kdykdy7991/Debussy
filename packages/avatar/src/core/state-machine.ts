import { AvatarError } from "./errors.js";
import type { AvatarState } from "./types.js";

const AVATAR_STATES = new Set<AvatarState>([
  "idle",
  "listening",
  "thinking",
  "speaking",
  "error",
]);

export function isAvatarState(value: unknown): value is AvatarState {
  return typeof value === "string" && AVATAR_STATES.has(value as AvatarState);
}

export function assertAvatarState(value: unknown): asserts value is AvatarState {
  if (!isAvatarState(value)) {
    throw new AvatarError("INVALID_CONFIG", `Unknown avatar state: ${String(value)}`);
  }
}

/** Internal state holder. Product-specific transition rules belong in adapters, not Core. */
export class AvatarStateMachine {
  #state: AvatarState = "idle";

  get state(): AvatarState {
    return this.#state;
  }

  transition(next: AvatarState): { previous: AvatarState; current: AvatarState } | undefined {
    assertAvatarState(next);

    if (next === this.#state) {
      return undefined;
    }

    const previous = this.#state;
    this.#state = next;
    return { previous, current: next };
  }
}
