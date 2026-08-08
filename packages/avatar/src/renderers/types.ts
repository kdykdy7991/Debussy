import type { AvatarState, CharacterManifest } from "../core/types.js";

/** Size in CSS pixels plus the physical-pixel scale used by the renderer. */
export interface AvatarViewport {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface AvatarRendererInitialization {
  /** Renderer-owned content must stay inside this element. */
  container: HTMLElement;
  /** Manifest is resolved and validated before it reaches the renderer. */
  character: CharacterManifest;
  initialState: AvatarState;
  /** Aborted when initialization is superseded or the avatar is destroyed. */
  signal: AbortSignal;
}

/**
 * Internal, framework-neutral rendering boundary.
 *
 * Implementations own their canvas/runtime resources but not the host container.
 * They must not emit product or Agent events; Core owns observable lifecycle events.
 */
export interface AvatarRenderer {
  initialize(input: AvatarRendererInitialization): Promise<void>;
  setState(state: AvatarState): void;
  setAudioLevel(level: number): void;
  resize(viewport: AvatarViewport): void;
  destroy(): void;
}

/** Factory registration keeps renderer selection outside Core and UI adapters. */
export interface AvatarRendererFactory {
  readonly type: CharacterManifest["renderer"];
  create(): AvatarRenderer;
}
