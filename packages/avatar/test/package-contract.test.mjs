import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("publishes stable avatar entry points", () => {
  assert.deepEqual(Object.keys(packageJson.exports), [
    ".",
    "./core",
    "./web-component",
    "./react",
    "./testing",
    "./package.json",
  ]);
});

test("keeps framework adapters out of the base runtime dependency graph", () => {
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.peerDependencies.react, ">=18.0.0");
  assert.equal(packageJson.peerDependenciesMeta.react.optional, true);
});

test("marks only the registration entry as side-effectful", () => {
  assert.deepEqual(packageJson.sideEffects, ["./dist/web-component/index.js"]);
});
