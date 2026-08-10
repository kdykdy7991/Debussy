import {
  AVATAR_PROTOCOL_VERSION,
  AvatarError,
  createAvatar,
  type AvatarConfig,
  type AvatarController,
  type AvatarEmbedHandle,
  type AvatarEmbedOptions,
  type AvatarEventDetail,
  type AvatarState,
  type CharacterManifest,
} from "../src/index.js";

const manifest = {
  id: "demo",
  version: "1.0.0",
  renderer: "rive",
  assetUrl: "/characters/demo/avatar.riv",
  stateMachine: "AvatarState",
  inputs: {
    idle: "idle",
    speaking: "speaking",
    audioLevel: "mouthOpen",
  },
} satisfies CharacterManifest;

const config = {
  character: manifest,
  mode: "floating",
  position: "bottom-right",
} satisfies AvatarConfig;

declare const controller: AvatarController;
controller.initialize(config);
controller.setState("thinking");
controller.speak({ audioUrl: "/demo.wav" });
controller.addEventListener("avatar-state-change", (event) => {
  const state: AvatarState = event.detail.current;
  void state;
});

const speechEnd: AvatarEventDetail<"avatar-speech-end"> = {
  audioUrl: "/demo.wav",
  reason: "completed",
};

const error = new AvatarError("INVALID_CONFIG", "Invalid avatar configuration");
const protocolVersion: 1 = AVATAR_PROTOCOL_VERSION;

void speechEnd;
void error;
void protocolVersion;

// @ts-expect-error Pi-specific states must not enter the public avatar contract.
controller.setState("tool-calling");

// @ts-expect-error Renderer implementation names are not valid avatar states.
const invalidState: AvatarState = "rive-idle";
void invalidState;

const invalidReason: AvatarEventDetail<"avatar-speech-end"> = {
  audioUrl: "/demo.wav",
  // @ts-expect-error Speech end reasons are a closed public union in protocol v1.
  reason: "cancelled",
};
void invalidReason;

// --- B4: createAvatar() embed surface (ADR-0005) ---

declare const mountTarget: HTMLElement;

const options: AvatarEmbedOptions = {
  target: mountTarget,
  character: manifest,
  mode: "floating",
  position: "bottom-right",
  width: 320,
  height: 480,
  background: "#101010",
  autoplay: false,
};
const handle: AvatarEmbedHandle = createAvatar(options);
const embedController: AvatarController = handle.controller;
embedController.setState("listening");
const embedReady: Promise<void> = handle.ready;
handle.destroy();

createAvatar({ target: "#host", character: "/demo.json" });

// @ts-expect-error target is required on AvatarEmbedOptions.
createAvatar({ character: manifest });
// @ts-expect-error target only accepts string | HTMLElement.
createAvatar({ target: 42, character: manifest });

void embedController;
void embedReady;
void options;
