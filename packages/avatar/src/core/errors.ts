export type AvatarErrorCode =
  | "NOT_INITIALIZED"
  | "ALREADY_DESTROYED"
  | "INVALID_CONFIG"
  | "INVALID_MANIFEST"
  | "CHARACTER_LOAD_FAILED"
  | "RENDERER_INITIALIZATION_FAILED"
  | "AUDIO_LOAD_FAILED"
  | "AUDIO_PLAYBACK_FAILED"
  | "AUDIO_AUTOPLAY_BLOCKED"
  | "UNSUPPORTED_BROWSER"
  | "INTERNAL_ERROR";

export interface AvatarErrorOptions extends ErrorOptions {
  cause?: unknown;
}

/** Stable public error shape exposed by Core and all adapters. */
export class AvatarError extends Error {
  readonly code: AvatarErrorCode;

  constructor(code: AvatarErrorCode, message: string, options?: AvatarErrorOptions) {
    super(message, options);
    this.name = "AvatarError";
    this.code = code;
  }
}
