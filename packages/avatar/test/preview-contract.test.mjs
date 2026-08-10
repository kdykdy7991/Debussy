import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateCharacterManifest } from "../dist/manifest/index.js";

const STATES = ["idle", "listening", "thinking", "speaking", "error"];

test("demo manifest is valid, complete, unique, pinned, and audio-free", async () => {
  const source = await readFile(
    new URL("../assets/characters/demo/manifest.json", import.meta.url),
    "utf8",
  );
  const manifest = validateCharacterManifest(JSON.parse(source));
  assert.deepEqual(Object.keys(manifest.inputs), STATES);
  assert.equal(new Set(Object.values(manifest.inputs)).size, STATES.length);
  assert.equal("audioLevel" in manifest.inputs, false);
  assert.match(manifest.assetUrl, /rive-app\/rive-wasm\/[a-f0-9]{40}\//);
  assert.match(manifest.assetUrl, /neostreamv2\.riv$/);
});

test("preview consumes only the production build and exposes visual controls", async () => {
  const [html, javascript] = await Promise.all([
    readFile(new URL("../dev/preview/index.html", import.meta.url), "utf8"),
    readFile(new URL("../dev/preview/preview.js", import.meta.url), "utf8"),
  ]);
  assert.match(javascript, /["']\/dist\/web-component\/index\.js["']/);
  assert.doesNotMatch(`${html}\n${javascript}`, /(?:\.\.\/)+src\//);
  for (const state of STATES) assert.match(html, new RegExp(`data-state="${state}"`));
  assert.match(html, /Destroy \/ Recreate/);
  assert.doesNotMatch(html, /speech|语音按钮|audioUrl/i);
});
