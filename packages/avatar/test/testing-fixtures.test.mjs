import assert from "node:assert/strict";
import test from "node:test";

import {
  FakeAudio,
  FakeRenderer,
  createAvatarTestHarness,
} from "../dist/testing/index.js";

function manifest() {
  return {
    id: "demo",
    version: "1.0.0",
    renderer: "rive",
    assetUrl: "/demo.riv",
    stateMachine: "AvatarState",
    inputs: {},
  };
}

test("test harness routes controller commands through reusable fakes", async () => {
  const container = { testId: "shadow-container" };
  const harness = createAvatarTestHarness({ container });
  await harness.controller.initialize({ character: manifest() });

  harness.controller.setState("thinking");
  harness.controller.setAudioLevel(0.6);
  harness.controller.hide();
  harness.runtime.resize({ width: 320, height: 480, devicePixelRatio: 2 });

  assert.deepEqual(
    harness.renderer.calls.map((call) => call.method),
    ["initialize", "setState", "setAudioLevel", "resize"],
  );
  assert.equal(harness.renderer.calls[0].input.container, container);
  assert.equal(harness.runtime.visible, false);
});

test("FakeAudio gives component tests deterministic control over speech completion", async () => {
  const harness = createAvatarTestHarness({ container: {} });
  await harness.controller.initialize({ character: manifest() });
  const events = [];
  harness.controller.addEventListener("avatar-speech-end", (event) => events.push(event.detail));

  const speaking = harness.controller.speak({ audioUrl: "/answer.wav" });
  await Promise.resolve();
  assert.equal(harness.audio.hasActiveSpeech, true);
  harness.audio.finishSpeech();
  await speaking;

  assert.deepEqual(events, [{ audioUrl: "/answer.wav", reason: "completed" }]);
  assert.equal(harness.controller.state, "idle");
});

test("FakeAudio can inject start and playback failures", async () => {
  const startFailure = new FakeAudio();
  startFailure.rejectNextStart(new Error("blocked"));
  await assert.rejects(
    startFailure.startSpeech({ audioUrl: "/answer.wav" }, new AbortController().signal),
    /blocked/,
  );

  const playbackFailure = new FakeAudio();
  const session = await playbackFailure.startSpeech(
    { audioUrl: "/answer.wav" },
    new AbortController().signal,
  );
  playbackFailure.failSpeech(new Error("decoder failed"));
  await assert.rejects(session.finished, /decoder failed/);
});

test("destroy tears down FakeAudio and FakeRenderer exactly once", async () => {
  const renderer = new FakeRenderer();
  const audio = new FakeAudio();
  const harness = createAvatarTestHarness({ container: {}, renderer, audio });
  await harness.controller.initialize({ character: manifest() });

  harness.controller.destroy();
  harness.controller.destroy();

  assert.equal(renderer.calls.filter((call) => call.method === "destroy").length, 1);
  assert.equal(audio.calls.filter((call) => call.method === "destroy").length, 1);
});
