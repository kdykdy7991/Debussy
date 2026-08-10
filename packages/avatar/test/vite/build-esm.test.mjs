import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { installDomShim } from "../helpers/dom-shim.mjs";

// The root entry now loads the <pi-avatar> class (which extends HTMLElement at
// module top-level) as part of the createAvatar embed surface (ADR-0005), so
// Node needs the DOM shim before importing any dist entry.
installDomShim();

// Runs against the full `npm run build` output (tsc declarations + Vite ESM).
// This file lives at test/vite/build-esm.test.mjs, so dist is two levels up.
const RUNTIME_ENTRY_PATHS = [
  "dist/index.js",
  "dist/core/index.js",
  "dist/web-component/index.js",
  "dist/react/index.js",
  "dist/testing/index.js",
];

function readEntry(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

async function importEntry(relativePath) {
  return import(new URL(`../../${relativePath}`, import.meta.url).href);
}

async function readReachableJavaScript(entryPaths) {
  const pending = [...entryPaths];
  const visited = new Map();
  while (pending.length > 0) {
    const relativePath = pending.pop();
    if (visited.has(relativePath)) continue;
    const source = await readEntry(relativePath);
    visited.set(relativePath, source);
    const importPattern = /(?:from\s*|import\s*)["'](\.[^"']+\.js)["']/g;
    for (const match of source.matchAll(importPattern)) {
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), match[1])));
    }
  }
  return visited;
}

test("Vite ESM build emits a file for every runtime package export", async () => {
  for (const entryPath of RUNTIME_ENTRY_PATHS) {
    await assert.doesNotReject(readEntry(entryPath), `${entryPath} is missing`);
  }
});

test("root and core bundles import cleanly and preserve public exports", async () => {
  const root = await importEntry("dist/index.js");
  assert.equal(typeof root.AvatarError, "function");
  assert.equal(root.AVATAR_PROTOCOL_VERSION, 1);
  assert.equal(typeof root.createAvatar, "function");

  const core = await importEntry("dist/core/index.js");
  assert.equal(typeof core.AvatarError, "function");
  assert.equal(core.AVATAR_PROTOCOL_VERSION, 1);
});

test("testing and root entries share runtime class identity", async () => {
  const [root, testing] = await Promise.all([
    importEntry("dist/index.js"),
    importEntry("dist/testing/index.js"),
  ]);
  const harness = testing.createAvatarTestHarness({ container: {} });

  assert.throws(
    () => harness.controller.setState("thinking"),
    (error) => error instanceof root.AvatarError && error.code === "NOT_INITIALIZED",
  );
});

test("React never enters the base runtime bundles", async () => {
  const [indexSource, coreSource] = await Promise.all([
    readEntry("dist/index.js"),
    readEntry("dist/core/index.js"),
  ]);
  assert.doesNotMatch(indexSource, /\breact\b/);
  assert.doesNotMatch(coreSource, /\breact\b/);
});

test("Rive runtime stays out of public base and embedding bundles", async () => {
  const entryPaths = [
    "dist/index.js",
    "dist/core/index.js",
    "dist/web-component/index.js",
    "dist/testing/index.js",
  ];
  const reachable = await readReachableJavaScript(entryPaths);
  for (const [relativePath, source] of reachable) {
    assert.doesNotMatch(
      source,
      /@rive-app|rive(?:_fallback)?\.wasm|RuntimeLoader/,
      `${relativePath} unexpectedly includes the Rive runtime`,
    );
  }
});

test("Rive runtime is emitted as a lazy non-entry chunk", async () => {
  const distUrl = new URL("../../dist/", import.meta.url);
  const outputPaths = await readdir(distUrl, { recursive: true });
  const javascriptPaths = outputPaths.filter((outputPath) => outputPath.endsWith(".js"));
  const chunks = await Promise.all(
    javascriptPaths.map(async (relativePath) => ({
      relativePath,
      source: await readFile(new URL(relativePath, distUrl), "utf8"),
    })),
  );
  const riveChunks = chunks.filter(({ source }) =>
    /RuntimeLoader|rive(?:_fallback)?\.wasm/.test(source),
  );
  assert.ok(riveChunks.length > 0, "build did not emit the dynamically loaded Rive runtime");
  for (const { relativePath } of riveChunks) {
    assert.equal(
      RUNTIME_ENTRY_PATHS.includes(`dist/${relativePath}`),
      false,
      `${relativePath} must remain a lazy chunk`,
    );
  }
});

test("media assets are not inlined into any SDK JavaScript chunk", async () => {
  const distUrl = new URL("../../dist/", import.meta.url);
  const outputPaths = await readdir(distUrl, { recursive: true });
  const javascriptPaths = outputPaths.filter((path) => path.endsWith(".js"));

  for (const relativePath of javascriptPaths) {
    const source = await readFile(new URL(relativePath, distUrl), "utf8");
    assert.doesNotMatch(
      source,
      // Require an actual base64 payload. The Rive SDK contains the literal
      // prefix `data:application/octet-stream;base64,` in its URL parser, but
      // that empty marker is code, not an inlined asset.
      /data:(?:image|audio|video|application)\/[^;"']*;base64,[A-Za-z0-9+/]{32}/,
      `dist/${relativePath} contains an inlined media asset`,
    );
  }
});
