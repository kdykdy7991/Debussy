import type {
  AvatarConfig,
  AvatarSpeechEndReason,
  AvatarSpeechInput,
  AvatarState,
} from "./types.js";

export interface AvatarSpeechSession {
  /** Settles when playback naturally ends, is stopped, or is interrupted. */
  readonly finished: Promise<AvatarSpeechEndReason>;
  stop(reason: "stopped" | "interrupted"): void;
}

/**
 * Internal capability port used by Core. It is intentionally not exported from
 * the package entry points; renderer and audio tasks provide the implementation.
 */
export interface AvatarRuntimePort {
  initialize(config: AvatarConfig): Promise<{ characterId: string }>;
  setState(state: AvatarState): void;
  setAudioLevel(level: number): void;
  startSpeech(input: AvatarSpeechInput, signal: AbortSignal): Promise<AvatarSpeechSession>;
  show(): void;
  hide(): void;
  destroy(): void;
}
