import assert from "node:assert/strict";
import test from "node:test";

import { CoreAvatarController } from "../dist/core/controller.js";
import { AvatarError } from "../dist/core/index.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRuntime() {
  const calls = [];
  const runtime = {
    calls,
    initializeCount: 0,
    initialize: async () => {
      runtime.initializeCount += 1;
      return { characterId: "demo" };
    },
    setState: (state) => calls.push(["setState", state]),
    setAudioLevel: (level) => calls.push(["setAudioLevel", level]),
    startSpeech: async () => {
      throw new Error("startSpeech not configured for this test");
    },
    show: () => calls.push(["show"]),
    hide: () => calls.push(["hide"]),
    destroy: () => calls.push(["destroy"]),
  };
  return runtime;
}

function config() {
  return {
    character: {
      id: "demo",
      version: "1.0.0",
      renderer: "rive",
      assetUrl: "/demo.riv",
      stateMachine: "AvatarState",
      inputs: {},
    },
  };
}

test("rejects commands before initialization with a stable error", () => {
  const controller = new CoreAvatarController(createRuntime());
  assert.throws(
    () => controller.setState("thinking"),
    (error) => error instanceof AvatarError && error.code === "NOT_INITIALIZED",
  );
});

test("initialization and duplicate state commands are idempotent", async () => {
  const runtime = createRuntime();
  const controller = new CoreAvatarController(runtime);
  const transitions = [];
  controller.addEventListener("avatar-state-change", (event) => transitions.push(event.detail));

  await controller.initialize(config());
  await controller.initialize(config());
  controller.setState("thinking");
  controller.setState("thinking");

  assert.equal(runtime.initializeCount, 1);
  assert.deepEqual(runtime.calls, [["setState", "thinking"]]);
  assert.deepEqual(transitions, [{ previous: "idle", current: "thinking" }]);
});

test("reports initialization failures and allows a later retry", async () => {
  const runtime = createRuntime();
  runtime.initialize = async () => {
    runtime.initializeCount += 1;
    if (runtime.initializeCount === 1) {
      throw new Error("asset unavailable");
    }
    return { characterId: "demo" };
  };
  const controller = new CoreAvatarController(runtime);
  const errors = [];
  controller.addEventListener("avatar-error", (event) => errors.push(event.detail));

  await assert.rejects(
    controller.initialize(config()),
    (error) => error instanceof AvatarError && error.code === "RENDERER_INITIALIZATION_FAILED",
  );
  await controller.initialize(config());

  assert.equal(runtime.initializeCount, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "RENDERER_INITIALIZATION_FAILED");
});

test("rejects invalid runtime states even when JavaScript bypasses TypeScript", async () => {
  const controller = new CoreAvatarController(createRuntime());
  await controller.initialize(config());

  assert.throws(
    () => controller.setState("dancing"),
    (error) => error instanceof AvatarError && error.code === "INVALID_CONFIG",
  );
});

test("clamps audio levels to the public 0..1 range", async () => {
  const runtime = createRuntime();
  const controller = new CoreAvatarController(runtime);
  await controller.initialize(config());

  controller.setAudioLevel(-1);
  controller.setAudioLevel(0.4);
  controller.setAudioLevel(8);
  controller.setAudioLevel(Number.NaN);

  assert.deepEqual(runtime.calls, [
    ["setAudioLevel", 0],
    ["setAudioLevel", 0.4],
    ["setAudioLevel", 1],
    ["setAudioLevel", 0],
  ]);
});

test("emits ordered speech events and returns to idle", async () => {
  const runtime = createRuntime();
  const finished = deferred();
  runtime.startSpeech = async () => ({
    finished: finished.promise,
    stop: () => {},
  });
  const controller = new CoreAvatarController(runtime);
  await controller.initialize(config());
  controller.setState("thinking");

  const events = [];
  for (const name of ["avatar-state-change", "avatar-speech-start", "avatar-speech-end"]) {
    controller.addEventListener(name, (event) => events.push([name, event.detail]));
  }

  const speaking = controller.speak({ audioUrl: "/answer.wav" });
  await Promise.resolve();
  finished.resolve("completed");
  await speaking;

  assert.equal(controller.state, "idle");
  assert.deepEqual(events, [
    ["avatar-state-change", { previous: "thinking", current: "speaking" }],
    ["avatar-speech-start", { audioUrl: "/answer.wav" }],
    ["avatar-speech-end", { audioUrl: "/answer.wav", reason: "completed" }],
    ["avatar-state-change", { previous: "speaking", current: "idle" }],
  ]);
});

test("a new speak aborts a pending older request without stale state writes", async () => {
  const runtime = createRuntime();
  const starts = [];
  runtime.startSpeech = (input, signal) => {
    const start = deferred();
    starts.push({ input, signal, start });
    return start.promise;
  };
  const controller = new CoreAvatarController(runtime);
  await controller.initialize(config());

  const first = controller.speak({ audioUrl: "/first.wav" });
  const second = controller.speak({ audioUrl: "/second.wav" });
  assert.equal(starts[0].signal.aborted, true);

  const secondFinished = deferred();
  starts[1].start.resolve({ finished: secondFinished.promise, stop: () => {} });
  await Promise.resolve();
  secondFinished.resolve("completed");
  await second;

  starts[0].start.reject(new DOMException("Aborted", "AbortError"));
  await first;
  assert.equal(controller.state, "idle");
});

test("stop and interrupt preserve their distinct end reasons", async () => {
  for (const [command, expectedReason] of [
    ["stopSpeaking", "stopped"],
    ["interrupt", "interrupted"],
  ]) {
    const runtime = createRuntime();
    const finished = deferred();
    runtime.startSpeech = async () => ({
      finished: finished.promise,
      stop: (reason) => finished.resolve(reason),
    });
    const controller = new CoreAvatarController(runtime);
    await controller.initialize(config());
    const ended = [];
    const interrupted = [];
    controller.addEventListener("avatar-speech-end", (event) => ended.push(event.detail));
    controller.addEventListener("avatar-interrupted", (event) => interrupted.push(event.detail));

    const speaking = controller.speak({ audioUrl: "/answer.wav" });
    await Promise.resolve();
    controller[command]();
    await speaking;

    assert.equal(ended[0].reason, expectedReason);
    assert.equal(interrupted.length, command === "interrupt" ? 1 : 0);
    assert.equal(controller.state, "idle");
  }
});

test("a runtime state failure does not mutate controller state", async () => {
  const runtime = createRuntime();
  runtime.setState = () => {
    throw new Error("renderer rejected state");
  };
  const controller = new CoreAvatarController(runtime);
  await controller.initialize(config());

  assert.throws(() => controller.setState("thinking"), /renderer rejected state/);
  assert.equal(controller.state, "idle");
});

test("destroy is idempotent and all later commands fail", async () => {
  const runtime = createRuntime();
  const controller = new CoreAvatarController(runtime);
  await controller.initialize(config());

  controller.destroy();
  controller.destroy();

  assert.equal(runtime.calls.filter(([name]) => name === "destroy").length, 1);
  assert.throws(
    () => controller.show(),
    (error) => error instanceof AvatarError && error.code === "ALREADY_DESTROYED",
  );
  assert.throws(
    () => controller.initialize(config()),
    (error) => error instanceof AvatarError && error.code === "ALREADY_DESTROYED",
  );
});
