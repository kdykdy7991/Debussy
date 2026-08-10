import assert from "node:assert/strict";
import test from "node:test";

import { AvatarError } from "../dist/core/index.js";
import { RiveAvatarRenderer } from "../dist/renderers/rive/index.js";

const INPUT = { Number: 56, Trigger: 58, Boolean: 59 };

function createInput(name, type) {
  let value = type === INPUT.Boolean ? false : 0;
  return {
    name,
    type,
    fireCount: 0,
    get value() {
      return value;
    },
    set value(next) {
      value = next;
    },
    fire() {
      this.fireCount += 1;
    },
  };
}

function createEnvironment({ inputs, load = "success" } = {}) {
  const children = [];
  const container = {
    children,
    appendChild(child) {
      children.push(child);
      child.parent = this;
      return child;
    },
  };
  const canvas = {
    attributes: {},
    style: {},
    parent: undefined,
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    remove() {
      if (this.parent) {
        const index = this.parent.children.indexOf(this);
        if (index >= 0) this.parent.children.splice(index, 1);
        this.parent = undefined;
      }
    },
  };
  const runtime = {
    cleanupCount: 0,
    resizeCalls: [],
    stateMachineNames: [],
    stateMachineInputs(name) {
      this.stateMachineNames.push(name);
      return inputs ?? [];
    },
    resizeDrawingSurfaceToCanvas(dpr) {
      this.resizeCalls.push(dpr);
    },
    cleanup() {
      this.cleanupCount += 1;
    },
  };
  let parameters;
  const dependencies = {
    createCanvas: () => canvas,
    createInstance(nextParameters) {
      parameters = nextParameters;
      if (load === "success") {
        queueMicrotask(() => nextParameters.onLoad({ type: "load" }));
      } else if (load === "error") {
        queueMicrotask(() =>
          nextParameters.onLoadError({ type: "loaderror", data: "bad rive file" }),
        );
      }
      return runtime;
    },
  };
  return { container, canvas, runtime, dependencies, getParameters: () => parameters };
}

function character(inputs = {}) {
  return {
    id: "demo",
    version: "1.0.0",
    renderer: "rive",
    assetUrl: "/characters/demo/avatar.riv",
    stateMachine: "AvatarState",
    inputs,
  };
}

test("loads a Rive file into an owned canvas and applies the initial state", async () => {
  const idle = createInput("idle", INPUT.Boolean);
  const speaking = createInput("speaking", INPUT.Boolean);
  const level = createInput("mouthOpen", INPUT.Number);
  const environment = createEnvironment({ inputs: [idle, speaking, level] });
  const renderer = new RiveAvatarRenderer(environment.dependencies);

  await renderer.initialize({
    container: environment.container,
    character: character({ idle: "idle", speaking: "speaking", audioLevel: "mouthOpen" }),
    initialState: "idle",
    signal: new AbortController().signal,
  });

  const parameters = environment.getParameters();
  assert.equal(parameters.src, "/characters/demo/avatar.riv");
  assert.equal(parameters.stateMachines, "AvatarState");
  assert.equal(parameters.autoplay, true);
  assert.equal(parameters.shouldDisableRiveListeners, true);
  assert.equal(parameters.automaticallyHandleEvents, false);
  assert.equal(environment.container.children[0], environment.canvas);
  assert.equal(environment.canvas.attributes["data-avatar-renderer"], "rive");
  assert.equal(idle.value, true);
  assert.equal(speaking.value, false);
  assert.equal(level.value, 0);
  assert.deepEqual(environment.runtime.resizeCalls, [undefined]);
});

test("maps states across boolean, number, and trigger inputs", async () => {
  const idle = createInput("idle", INPUT.Boolean);
  const thinking = createInput("thinking", INPUT.Number);
  const error = createInput("error", INPUT.Trigger);
  const environment = createEnvironment({ inputs: [idle, thinking, error] });
  const renderer = new RiveAvatarRenderer(environment.dependencies);
  await renderer.initialize({
    container: environment.container,
    character: character({ idle: "idle", thinking: "thinking", error: "error" }),
    initialState: "idle",
    signal: new AbortController().signal,
  });

  renderer.setState("thinking");
  assert.equal(idle.value, false);
  assert.equal(thinking.value, 1);
  renderer.setState("error");
  assert.equal(thinking.value, 0);
  assert.equal(error.fireCount, 1);
});

test("normalizes audio level and resizes with an explicit DPR", async () => {
  const level = createInput("mouthOpen", INPUT.Number);
  const environment = createEnvironment({ inputs: [level] });
  const renderer = new RiveAvatarRenderer(environment.dependencies);
  await renderer.initialize({
    container: environment.container,
    character: character({ audioLevel: "mouthOpen" }),
    initialState: "idle",
    signal: new AbortController().signal,
  });

  renderer.setAudioLevel(3);
  assert.equal(level.value, 1);
  renderer.resize({ width: 320, height: 480, devicePixelRatio: 2 });
  assert.equal(environment.canvas.style.width, "320px");
  assert.equal(environment.canvas.style.height, "480px");
  assert.deepEqual(environment.runtime.resizeCalls, [undefined, 2]);
});

test("rejects missing, duplicate, and invalid audio input mappings", async () => {
  const cases = [
    {
      available: [],
      mapping: { idle: "missing" },
      message: /input not found/,
    },
    {
      available: [createInput("shared", INPUT.Boolean)],
      mapping: { idle: "shared", thinking: "shared" },
      message: /must be unique/,
    },
    {
      available: [createInput("mouthOpen", INPUT.Boolean)],
      mapping: { audioLevel: "mouthOpen" },
      message: /must be Number/,
    },
  ];

  for (const scenario of cases) {
    const environment = createEnvironment({ inputs: scenario.available });
    const renderer = new RiveAvatarRenderer(environment.dependencies);
    await assert.rejects(
      renderer.initialize({
        container: environment.container,
        character: character(scenario.mapping),
        initialState: "idle",
        signal: new AbortController().signal,
      }),
      (error) =>
        error instanceof AvatarError &&
        error.code === "INVALID_MANIFEST" &&
        scenario.message.test(error.message),
    );
    assert.equal(environment.runtime.cleanupCount, 1);
    assert.equal(environment.container.children.length, 0);
  }
});

test("reports Rive load failures and cleans partial resources", async () => {
  const environment = createEnvironment({ load: "error" });
  const renderer = new RiveAvatarRenderer(environment.dependencies);
  await assert.rejects(
    renderer.initialize({
      container: environment.container,
      character: character(),
      initialState: "idle",
      signal: new AbortController().signal,
    }),
    (error) =>
      error instanceof AvatarError &&
      error.code === "RENDERER_INITIALIZATION_FAILED" &&
      error.message.includes("bad rive file"),
  );
  assert.equal(environment.runtime.cleanupCount, 1);
  assert.equal(environment.container.children.length, 0);
});

test("aborts initialization and makes destroy idempotent", async () => {
  const environment = createEnvironment({ load: "pending" });
  const renderer = new RiveAvatarRenderer(environment.dependencies);
  const abortController = new AbortController();
  const initializing = renderer.initialize({
    container: environment.container,
    character: character(),
    initialState: "idle",
    signal: abortController.signal,
  });
  abortController.abort();

  await assert.rejects(initializing, (error) => error.name === "AbortError");
  assert.equal(environment.runtime.cleanupCount, 1);
  assert.equal(environment.container.children.length, 0);
  renderer.destroy();
  renderer.destroy();
  assert.equal(environment.runtime.cleanupCount, 1);
});

test("destroy rejects a pending initialization without requiring the host signal", async () => {
  const environment = createEnvironment({ load: "pending" });
  const renderer = new RiveAvatarRenderer(environment.dependencies);
  const initializing = renderer.initialize({
    container: environment.container,
    character: character(),
    initialState: "idle",
    signal: new AbortController().signal,
  });

  renderer.destroy();
  await assert.rejects(initializing, (error) => error.name === "AbortError");
  assert.equal(environment.runtime.cleanupCount, 1);
  assert.equal(environment.container.children.length, 0);
});

test("rejects commands before initialization and after destroy", async () => {
  const environment = createEnvironment();
  const renderer = new RiveAvatarRenderer(environment.dependencies);
  assert.throws(
    () => renderer.setState("thinking"),
    (error) => error instanceof AvatarError && error.code === "NOT_INITIALIZED",
  );

  await renderer.initialize({
    container: environment.container,
    character: character(),
    initialState: "idle",
    signal: new AbortController().signal,
  });
  renderer.destroy();
  assert.throws(
    () => renderer.resize({ width: 1, height: 1, devicePixelRatio: 1 }),
    (error) => error instanceof AvatarError && error.code === "ALREADY_DESTROYED",
  );
});
