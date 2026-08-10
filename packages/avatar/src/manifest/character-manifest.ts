import { AvatarError } from "../core/errors.js";
import type { AvatarState, CharacterManifest } from "../core/types.js";

const MANIFEST_KEYS = new Set([
  "id",
  "version",
  "renderer",
  "assetUrl",
  "stateMachine",
  "inputs",
]);

const INPUT_KEYS = new Set<AvatarState | "audioLevel">([
  "idle",
  "listening",
  "thinking",
  "speaking",
  "error",
  "audioLevel",
]);

export type CharacterManifestFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CharacterManifestLoadOptions {
  fetch?: CharacterManifestFetch;
  signal?: AbortSignal;
}

function invalidManifest(message: string, cause?: unknown): AvatarError {
  return new AvatarError("INVALID_MANIFEST", message, { cause });
}

function characterLoadFailed(message: string, cause?: unknown): AvatarError {
  return new AvatarError("CHARACTER_LOAD_FAILED", message, { cause });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function nonEmptyString(
  value: unknown,
  field: "id" | "version" | "assetUrl" | "stateMachine",
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidManifest(`Character manifest ${field} must be a non-empty string`);
  }
  return value.trim();
}

function validateInputs(value: unknown): CharacterManifest["inputs"] {
  if (!isPlainObject(value)) {
    throw invalidManifest("Character manifest inputs must be an object");
  }

  const inputs: CharacterManifest["inputs"] = {};
  const mappedNames = new Set<string>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !INPUT_KEYS.has(key as AvatarState | "audioLevel")) {
      throw invalidManifest(`Character manifest contains an unsupported input key: ${String(key)}`);
    }
    const rawName = value[key];
    if (typeof rawName !== "string" || rawName.trim().length === 0) {
      throw invalidManifest(`Character manifest input ${key} must be a non-empty string`);
    }
    const inputName = rawName.trim();
    if (mappedNames.has(inputName)) {
      throw invalidManifest(`Character manifest input mappings must be unique: ${inputName}`);
    }
    mappedNames.add(inputName);
    inputs[key as AvatarState | "audioLevel"] = inputName;
  }
  return inputs;
}

/**
 * Validate untrusted JSON or an object supplied through AvatarConfig.
 *
 * The returned manifest is a fresh, normalized object. The caller's object is
 * never mutated, and renderer-specific work still happens behind the internal
 * renderer boundary.
 */
export function validateCharacterManifest(value: unknown): CharacterManifest {
  if (!isPlainObject(value)) {
    throw invalidManifest("Character manifest must be an object");
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !MANIFEST_KEYS.has(key)) {
      throw invalidManifest(`Character manifest contains an unsupported field: ${String(key)}`);
    }
  }

  if (value.renderer !== "rive") {
    throw invalidManifest('Character manifest renderer must be "rive"');
  }

  return {
    id: nonEmptyString(value.id, "id"),
    version: nonEmptyString(value.version, "version"),
    renderer: "rive",
    assetUrl: nonEmptyString(value.assetUrl, "assetUrl"),
    stateMachine: nonEmptyString(value.stateMachine, "stateMachine"),
    inputs: validateInputs(value.inputs),
  };
}

function resolveAssetUrl(manifest: CharacterManifest, responseUrl: string): CharacterManifest {
  try {
    return {
      ...manifest,
      assetUrl: responseUrl
        ? new URL(manifest.assetUrl, responseUrl).href
        : new URL(manifest.assetUrl).href,
    };
  } catch (cause: unknown) {
    throw invalidManifest(
      "Character manifest assetUrl cannot be resolved against the manifest response URL",
      cause,
    );
  }
}

function getFetch(override: CharacterManifestFetch | undefined): CharacterManifestFetch {
  if (override) {
    return override;
  }
  if (typeof globalThis.fetch !== "function") {
    throw characterLoadFailed("Character manifest cannot be loaded because fetch is unavailable");
  }
  return globalThis.fetch.bind(globalThis);
}

/** Load and validate a Character Manifest object or URL. Internal to Avatar. */
export async function loadCharacterManifest(
  input: CharacterManifest | string,
  options: CharacterManifestLoadOptions = {},
): Promise<CharacterManifest> {
  if (typeof input !== "string") {
    return validateCharacterManifest(input);
  }

  const manifestUrl = input.trim();
  if (!manifestUrl) {
    throw invalidManifest("Character manifest URL must be a non-empty string");
  }
  if (options.signal?.aborted) {
    throw characterLoadFailed("Character manifest request was aborted", options.signal.reason);
  }

  const fetchManifest = getFetch(options.fetch);
  let response: Response;
  try {
    const init: RequestInit = {};
    if (options.signal) {
      init.signal = options.signal;
    }
    response = await fetchManifest(manifestUrl, init);
  } catch (cause: unknown) {
    throw characterLoadFailed(`Character manifest request failed: ${manifestUrl}`, cause);
  }

  if (!response.ok) {
    throw characterLoadFailed(
      `Character manifest request failed with HTTP ${response.status}: ${manifestUrl}`,
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch (cause: unknown) {
    throw characterLoadFailed(`Character manifest response is not valid JSON: ${manifestUrl}`, cause);
  }

  return resolveAssetUrl(validateCharacterManifest(value), response.url);
}
