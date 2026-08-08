import type { AvatarController } from "../src/index.js";
import {
  FakeAudio,
  FakeAvatarRuntime,
  FakeRenderer,
  createAvatarTestHarness,
  type AvatarTestHarness,
} from "../src/testing/index.js";

declare const container: HTMLElement;

const renderer = new FakeRenderer();
const audio = new FakeAudio();
const runtime = new FakeAvatarRuntime({ container, renderer, audio });
const harness = createAvatarTestHarness({ container, renderer, audio });

const controller: AvatarController = harness.controller;
const typedHarness: AvatarTestHarness = { controller, runtime, renderer, audio };

typedHarness.renderer.resize({ width: 320, height: 480, devicePixelRatio: 2 });
typedHarness.audio.finishSpeech("completed");

// @ts-expect-error Testing harness requires an explicit host container.
createAvatarTestHarness({});

// @ts-expect-error Fake completion reasons follow the frozen speech reason union.
audio.finishSpeech("cancelled");
