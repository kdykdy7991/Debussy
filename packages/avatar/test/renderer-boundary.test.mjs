import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const boundaryFiles = [
  "../src/core/controller.ts",
  "../src/core/runtime.ts",
  "../src/core/state-machine.ts",
  "../src/renderers/types.ts",
];

test("Core and renderer contracts do not import a concrete rendering SDK", async () => {
  for (const relativePath of boundaryFiles) {
    const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["']@rive-app\//, relativePath);
    assert.doesNotMatch(source, /from\s+["']three["']/, relativePath);
    assert.doesNotMatch(source, /from\s+["']pixi\.js["']/, relativePath);
  }
});

test("renderer contract stays internal to the published package", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.exports["./renderers"], undefined);
});
