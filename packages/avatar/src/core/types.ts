import type { AvatarError } from "./errors.js";

export const AVATAR_PROTOCOL_VERSION = 1 as const;

export type AvatarState = "idle" | "listening" | "thinking" | "speaking" | "error";
export type AvatarDisplayMode = "inline" | "floating";
export type AvatarPosition = "bottom-left" | "bottom-right";
export type AvatarSpeechEndReason = "completed" | "stopped" | "interrupted" | "failed";

export interface CharacterManifest {
  id: string;
  version: string;
  renderer: "rive";
  assetUrl: string;
  stateMachine: string;
  inputs: Partial<Record<AvatarState | "audioLevel", string>>;
}

export interface AvatarConfig {
  character: CharacterManifest | string;
  mode?: AvatarDisplayMode;
  position?: AvatarPosition;
  width?: number | string;
  height?: number | string;
  background?: string;
  autoplay?: boolean;
}

export interface AvatarSpeechInput {
  audioUrl: string;
}

export interface AvatarEventMap {
  "avatar-ready": CustomEvent<{ characterId: string }>;
  "avatar-state-change": CustomEvent<{ previous: AvatarState; current: AvatarState }>;
  "avatar-speech-start": CustomEvent<{ audioUrl: string }>;
  "avatar-speech-end": CustomEvent<{
    audioUrl: string;
    reason: AvatarSpeechEndReason;
  }>;
  "avatar-error": CustomEvent<{
    code: AvatarError["code"];
    message: string;
    cause?: unknown;
  }>;
  "avatar-interrupted": CustomEvent<{ source: "host" | "user" }>;
}

export type AvatarEventName = keyof AvatarEventMap;
export type AvatarEventDetail<Name extends AvatarEventName> = AvatarEventMap[Name]["detail"];

export interface AvatarEventTarget {
  addEventListener<Name extends AvatarEventName>(
    type: Name,
    listener: (event: AvatarEventMap[Name]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<Name extends AvatarEventName>(
    type: Name,
    listener: (event: AvatarEventMap[Name]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
}

export interface AvatarController extends AvatarEventTarget {
  readonly state: AvatarState;
  initialize(config: AvatarConfig): Promise<void>;
  setState(state: AvatarState): void;
  setAudioLevel(level: number): void;
  speak(input: AvatarSpeechInput): Promise<void>;
  stopSpeaking(): void;
  interrupt(): void;
  show(): void;
  hide(): void;
  destroy(): void;
}
