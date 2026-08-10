import assert from "node:assert/strict";
import test from "node:test";

import { AvatarError } from "../dist/core/index.js";
import {
  loadCharacterManifest,
  validateCharacterManifest,
} from "../dist/manifest/index.js";

function manifest(overrides = {}) {
  return {
    id: " demo ",
    version: " 1.0.0 ",
    renderer: "rive",
    assetUrl: " ./avatar.riv ",
    stateMachine: " AvatarState ",
    inputs: {
      idle: " idle ",
      thinking: "thinking",
      audioLevel: " mouthOpen ",
    },
    ...overrides,
  };
}

function response({
  value = manifest(),
  url = "https://cdn.example.com/characters/demo/manifest.json",
  ok = true,
  status = 200,
  jsonError,
} = {}) {
  return {
    ok,
    status,
    url,
    async json() {
      if (jsonError) throw jsonError;
      return value;
    },
  };
}

function hasCode(code) {
  return (error) => error instanceof AvatarError && error.code === code;
}

test("validates and normalizes object input without fetching or mutating it", async () => {
  const input = manifest();
  let fetchCalls = 0;
  const result = await loadCharacterManifest(input, {
    fetch: async () => {
      fetchCalls += 1;
      return response();
    },
  });

  assert.equal(fetchCalls, 0);
  assert.notEqual(result, input);
  assert.equal(input.id, " demo ");
  assert.deepEqual(result, {
    id: "demo",
    version: "1.0.0",
    renderer: "rive",
    assetUrl: "./avatar.riv",
    stateMachine: "AvatarState",
    inputs: { idle: "idle", thinking: "thinking", audioLevel: "mouthOpen" },
  });
});

test("accepts partial and empty input mappings", () => {
  assert.deepEqual(validateCharacterManifest(manifest({ inputs: {} })).inputs, {});
  assert.deepEqual(
    validateCharacterManifest(manifest({ inputs: { speaking: "talk" } })).inputs,
    { speaking: "talk" },
  );
});

test("loads a URL, forwards the exact signal, and resolves assets from the final response URL", async () => {
  const abort = new AbortController();
  const calls = [];
  const result = await loadCharacterManifest("  /demo/manifest.json  ", {
    signal: abort.signal,
    fetch: async (url, init) => {
      calls.push({ url, signal: init.signal });
      return response({
        url: "https://edge.example.com/releases/v2/manifest.json",
        value: manifest({ assetUrl: "../assets/avatar.riv" }),
      });
    },
  });

  assert.deepEqual(calls, [{ url: "/demo/manifest.json", signal: abort.signal }]);
  assert.equal(result.assetUrl, "https://edge.example.com/releases/assets/avatar.riv");
});

test("does not cache URL requests or failed promises", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return response({ value: manifest({ assetUrl: "https://cdn.example.com/avatar.riv" }) });
  };

  await loadCharacterManifest("https://cdn.example.com/manifest.json", { fetch });
  await loadCharacterManifest("https://cdn.example.com/manifest.json", { fetch });
  assert.equal(calls, 2);
});

test("maps HTTP, fetch, and JSON failures to CHARACTER_LOAD_FAILED with causes", async () => {
  await assert.rejects(
    loadCharacterManifest("https://cdn.example.com/missing.json", {
      fetch: async () => response({ ok: false, status: 404 }),
    }),
    hasCode("CHARACTER_LOAD_FAILED"),
  );

  const networkCause = new TypeError("CORS blocked");
  await assert.rejects(
    loadCharacterManifest("https://cdn.example.com/manifest.json", {
      fetch: async () => {
        throw networkCause;
      },
    }),
    (error) => hasCode("CHARACTER_LOAD_FAILED")(error) && error.cause === networkCause,
  );

  const jsonCause = new SyntaxError("bad json");
  await assert.rejects(
    loadCharacterManifest("https://cdn.example.com/manifest.json", {
      fetch: async () => response({ jsonError: jsonCause }),
    }),
    (error) => hasCode("CHARACTER_LOAD_FAILED")(error) && error.cause === jsonCause,
  );
});

test("keeps a fetched schema failure as INVALID_MANIFEST", async () => {
  await assert.rejects(
    loadCharacterManifest("https://cdn.example.com/manifest.json", {
      fetch: async () => response({ value: { renderer: "rive" } }),
    }),
    hasCode("INVALID_MANIFEST"),
  );
});

test("rejects malformed top-level values and required fields", () => {
  const invalidValues = [null, [], new Date(), "manifest"];
  for (const value of invalidValues) {
    assert.throws(() => validateCharacterManifest(value), hasCode("INVALID_MANIFEST"));
  }

  for (const field of ["id", "version", "assetUrl", "stateMachine"]) {
    assert.throws(
      () => validateCharacterManifest(manifest({ [field]: "   " })),
      hasCode("INVALID_MANIFEST"),
      field,
    );
  }
  assert.throws(
    () => validateCharacterManifest(manifest({ renderer: "three" })),
    hasCode("INVALID_MANIFEST"),
  );
});

test("rejects unsupported top-level fields instead of accepting executable extensions", () => {
  assert.throws(
    () => validateCharacterManifest(manifest({ scriptUrl: "https://evil.example/run.js" })),
    (error) => hasCode("INVALID_MANIFEST")(error) && /scriptUrl/.test(error.message),
  );
});

test("rejects invalid input containers, keys, names, symbols, and duplicates after trimming", () => {
  assert.throws(
    () => validateCharacterManifest(manifest({ inputs: [] })),
    hasCode("INVALID_MANIFEST"),
  );
  assert.throws(
    () => validateCharacterManifest(manifest({ inputs: { dance: "dance" } })),
    hasCode("INVALID_MANIFEST"),
  );
  assert.throws(
    () => validateCharacterManifest(manifest({ inputs: { idle: " " } })),
    hasCode("INVALID_MANIFEST"),
  );
  assert.throws(
    () => validateCharacterManifest(manifest({ inputs: { idle: "same", thinking: " same " } })),
    hasCode("INVALID_MANIFEST"),
  );
  const withSymbol = { idle: "idle", [Symbol("hidden")]: "secret" };
  assert.throws(
    () => validateCharacterManifest(manifest({ inputs: withSymbol })),
    hasCode("INVALID_MANIFEST"),
  );
});

test("pre-aborted requests fail before fetch without installing loader listeners", async () => {
  const abort = new AbortController();
  abort.abort("superseded");
  let fetchCalls = 0;
  await assert.rejects(
    loadCharacterManifest("https://cdn.example.com/manifest.json", {
      signal: abort.signal,
      fetch: async () => {
        fetchCalls += 1;
        return response();
      },
    }),
    (error) =>
      hasCode("CHARACTER_LOAD_FAILED")(error) && error.cause === "superseded",
  );
  assert.equal(fetchCalls, 0);
});

test("rejects an unresolvable relative asset when the response has no final URL", async () => {
  await assert.rejects(
    loadCharacterManifest("manifest.json", {
      fetch: async () => response({ url: "", value: manifest({ assetUrl: "./avatar.riv" }) }),
    }),
    hasCode("INVALID_MANIFEST"),
  );
});

test("manifest loader remains internal to public package entries", async () => {
  const [root, core] = await Promise.all([
    import("../dist/index.js"),
    import("../dist/core/index.js"),
  ]);
  assert.equal("loadCharacterManifest" in root, false);
  assert.equal("validateCharacterManifest" in root, false);
  assert.equal("loadCharacterManifest" in core, false);
  assert.equal("validateCharacterManifest" in core, false);
});
