import { createAvatarTestHarness } from "../../dist/testing/index.js";

/**
 * Shared factory for embed tests. Each connect creates a fresh harness so that
 * reconnect and re-creation after destroy are observable.
 */
export function makeFactory() {
  let harness;
  const factory = (container) => {
    harness = createAvatarTestHarness({ container });
    return harness.controller;
  };
  return { factory, getHarness: () => harness };
}