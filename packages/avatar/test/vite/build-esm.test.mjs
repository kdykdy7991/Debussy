import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

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

test("Vite ESM build emits a file for every runtime package export", async () => {
  for (const entryPath of RUNTIME_ENTRY_PATHS) {
    await assert.doesNotReject(readEntry(entryPath), `${entryPath} is missing`);
  }
});

test("root and core bundles import cleanly and preserve public exports", async () => {
  const root = await importEntry("dist/index.js");
  assert.equal(typeof root.AvatarError, "function");
  assert.equal(root.AVATAR_PROTOCOL_VERSION, 1);

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

test("media assets are not inlined into any SDK JavaScript chunk", async () => {
  const distUrl = new URL("../../dist/", import.meta.url);
  const outputPaths = await readdir(distUrl, { recursive: true });
  const javascriptPaths = outputPaths.filter((path) => path.endsWith(".js"));

  for (const relativePath of javascriptPaths) {
    const source = await readFile(new URL(relativePath, distUrl), "utf8");
    assert.doesNotMatch(
      source,
      /data:(?:image|audio|video|application)\//,
      `dist/${relativePath} contains an inlined media asset`,
    );
  }
});
