export type {
  AvatarConfig,
  AvatarController,
  AvatarDisplayMode,
  AvatarEventDetail,
  AvatarEventMap,
  AvatarEventName,
  AvatarEventTarget,
  AvatarPosition,
  AvatarSpeechEndReason,
  AvatarSpeechInput,
  AvatarState,
  CharacterManifest,
} from "./core/index.js";
export { AvatarError, AVATAR_PROTOCOL_VERSION } from "./core/index.js";
export type { AvatarErrorCode, AvatarErrorOptions } from "./core/index.js";
export { createAvatar } from "./embed/index.js";
export type { AvatarEmbedHandle, AvatarEmbedOptions } from "./embed/index.js";
