import assert from "node:assert/strict";
import test from "node:test";

import { AvatarError } from "../dist/core/index.js";
import { VisualAvatarRuntime } from "../dist/runtime/index.js";

const STATES = ["idle", "listening", "thinking", "speaking", "error"];

function character(id = "demo") {
  return {
    id,
    version: "1.0.0",
    renderer: "rive",
    assetUrl: "https://example.test/avatar.riv",
    stateMachine: "AvatarState",
    inputs: {
      idle: "idle",
      listening: "listen",
      thinking: "think",
      speaking: "speak",
      error: "fail",
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function environment(options = {}) {
  const calls = [];
  const container = {
    hidden: false,
    bounds: options.bounds ?? { width: 320, height: 480 },
    getBoundingClientRect() {
      return this.bounds;
    },
  };
  const renderer = {
    destroyed: false,
    async initialize(input) {
      calls.push({ method: "initialize", input });
      if (options.initialize) await options.initialize(input);
    },
    setState(state) {
      calls.push({ method: "setState", state });
    },
    setAudioLevel(level) {
      calls.push({ method: "setAudioLevel", level });
    },
    resize(viewport) {
      calls.push({ method: "resize", viewport });
      if (options.resizeError) throw options.resizeError;
    },
    destroy() {
      this.destroyed = true;
      calls.push({ method: "destroy" });
    },
  };
  let resizeCallback;
  const observer = {
    observed: [],
    disconnectCount: 0,
    observe(target) {
      this.observed.push(target);
    },
    disconnect() {
      this.disconnectCount += 1;
    },
  };
  const manifestCalls = [];
  const dependencies = {
    async loadManifest(input, loadOptions) {
      manifestCalls.push({ input, signal: loadOptions.signal });
      if (options.loadManifest) return options.loadManifest(input, loadOptions);
      return typeof input === "string" ? character("from-url") : input;
    },
    async createRenderer() {
      calls.push({ method: "createRenderer" });
      return renderer;
    },
    createResizeObserver(callback) {
      resizeCallback = callback;
      return observer;
    },
    getDevicePixelRatio() {
      return options.dpr ?? 2;
    },
  };
  return {
    calls,
    container,
    dependencies,
    manifestCalls,
    observer,
    renderer,
    resize: () => resizeCallback?.(),
  };
}

test("loads object and URL manifests and returns the resolved character id", async () => {
  const first = environment();
  const objectRuntime = new VisualAvatarRuntime(first.container, first.dependencies);
  assert.deepEqual(await objectRuntime.initialize({ character: character("object") }), {
    characterId: "object",
  });
  assert.equal(first.manifestCalls[0].input.id, "object");

  const second = environment();
  const urlRuntime = new VisualAvatarRuntime(second.container, second.dependencies);
  assert.deepEqual(await urlRuntime.initialize({ character: "/demo/manifest.json" }), {
    characterId: "from-url",
  });
  assert.equal(second.manifestCalls[0].input, "/demo/manifest.json");
  assert.equal(second.manifestCalls[0].signal instanceof AbortSignal, true);
});

test("forwards all five states and audio level to one renderer instance", async () => {
  const env = environment();
  const runtime = new VisualAvatarRuntime(env.container, env.dependencies);
  await runtime.initialize({ character: character() });
  for (const state of STATES) runtime.setState(state);
  runtime.setAudioLevel(0.4);

  assert.deepEqual(
    env.calls.filter((call) => call.method === "setState").map((call) => call.state),
    STATES,
  );
  assert.equal(env.calls.at(-1).level, 0.4);
  assert.equal(env.calls.filter((call) => call.method === "createRenderer").length, 1);
});

test("performs initial resize and observes later finite DPR resize", async () => {
  const env = environment({ dpr: Number.NaN });
  const runtime = new VisualAvatarRuntime(env.container, env.dependencies);
  await runtime.initialize({ character: character() });

  assert.deepEqual(env.calls.find((call) => call.method === "resize").viewport, {
    width: 320,
    height: 480,
    devicePixelRatio: 1,
  });
  assert.deepEqual(env.observer.observed, [env.container]);

  env.container.bounds = { width: 375, height: 260 };
  env.resize();
  assert.deepEqual(env.calls.filter((call) => call.method === "resize").at(-1).viewport, {
    width: 375,
    height: 260,
    devicePixelRatio: 1,
  });
});

test("show, hide, destroy, and repeated destroy are deterministic", async () => {
  const env = environment();
  const runtime = new VisualAvatarRuntime(env.container, env.dependencies);
  await runtime.initialize({ character: character() });
  runtime.hide();
  assert.equal(env.container.hidden, true);
  runtime.show();
  assert.equal(env.container.hidden, false);

  runtime.destroy();
  runtime.destroy();
  assert.equal(env.observer.disconnectCount, 1);
  assert.equal(env.calls.filter((call) => call.method === "destroy").length, 1);
  assert.throws(
    () => runtime.setState("idle"),
    (error) => error instanceof AvatarError && error.code === "ALREADY_DESTROYED",
  );
});

test("destroy during manifest load aborts initialization without creating a renderer", async () => {
  const pending = deferred();
  const env = environment({ loadManifest: () => pending.promise });
  const runtime = new VisualAvatarRuntime(env.container, env.dependencies);
  const initializing = runtime.initialize({ character: "/slow.json" });
  const rejected = assert.rejects(initializing, (error) => error.name === "AbortError");
  runtime.destroy();
  pending.resolve(character());
  await rejected;
  assert.equal(env.calls.some((call) => call.method === "createRenderer"), false);
});

test("multiple runtimes isolate renderer, observer, and destruction", async () => {
  const first = environment();
  const second = environment();
  const firstRuntime = new VisualAvatarRuntime(first.container, first.dependencies);
  const secondRuntime = new VisualAvatarRuntime(second.container, second.dependencies);
  await Promise.all([
    firstRuntime.initialize({ character: character("first") }),
    secondRuntime.initialize({ character: character("second") }),
  ]);
  firstRuntime.setState("thinking");
  assert.equal(first.calls.some((call) => call.state === "thinking"), true);
  assert.equal(second.calls.some((call) => call.state === "thinking"), false);
  firstRuntime.destroy();
  assert.equal(first.renderer.destroyed, true);
  assert.equal(second.renderer.destroyed, false);
  secondRuntime.destroy();
});

test("manifest failures clean up and speech rejects as explicitly unavailable", async () => {
  const loadError = new AvatarError("CHARACTER_LOAD_FAILED", "offline");
  const failed = environment({ loadManifest: async () => { throw loadError; } });
  const failedRuntime = new VisualAvatarRuntime(failed.container, failed.dependencies);
  await assert.rejects(
    failedRuntime.initialize({ character: "/missing.json" }),
    (error) => error === loadError,
  );

  const ready = environment();
  const runtime = new VisualAvatarRuntime(ready.container, ready.dependencies);
  await runtime.initialize({ character: character() });
  await assert.rejects(
    runtime.startSpeech({ audioUrl: "/not-used.mp3" }, new AbortController().signal),
    (error) =>
      error instanceof AvatarError &&
      error.code === "AUDIO_PLAYBACK_FAILED" &&
      /not installed/.test(error.message),
  );
});

test("ResizeObserver callback swallows transient resize errors", async () => {
  const env = environment({ resizeError: new Error("layout race") });
  const runtime = new VisualAvatarRuntime(env.container, env.dependencies);
  await assert.rejects(runtime.initialize({ character: character() }));

  const stable = environment();
  const stableRuntime = new VisualAvatarRuntime(stable.container, stable.dependencies);
  await stableRuntime.initialize({ character: character() });
  stable.renderer.resize = () => { throw new Error("layout race"); };
  assert.doesNotThrow(() => stable.resize());
  stableRuntime.destroy();
});
