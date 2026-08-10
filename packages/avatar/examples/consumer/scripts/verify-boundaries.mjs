import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const consumerRoot = resolve(here, "..");
const repoRoot = resolve(consumerRoot, "..", "..", "..", "..");

// Tokens the consumer must never bake into its shipped output.
// - "@skdy/avatar/testing" forbids private test-entry imports.
// - "packages/avatar/src" and "packages/avatar/dist" forbid in-tree source
//   leaks of the package into the consumer.
// - Absolute paths inside the source repo.
const forbiddenTokens = ["@skdy/avatar/testing", "packages/avatar/src", "packages/avatar/dist"];
const repoAbsolutePrefix = repoRoot.replace(/\\/g, "/") + "/";

// Files/dirs we are willing to scan. We always include the production dist so
// the scan actually reflects what gets shipped, plus source-level roots.
const scanRoots = ["src", "index.html", "vite.config.ts", "dist"];

async function collectFiles(target, { required = false } = {}) {
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOTDIR") return [target];
    if (error?.code === "ENOENT" && !required) return [];
    throw error;
  }

  const collected = [];
  for (const entry of entries) {
    const child = join(target, entry.name);
    if (entry.isDirectory()) {
      collected.push(...(await collectFiles(child, { required: true })));
    } else if (entry.isFile()) {
      collected.push(child);
    }
  }
  return collected;
}

const files = (
  await Promise.all(
    scanRoots.map((root) => collectFiles(root, { required: root === "dist" })),
  )
).flat();
if (!files.length) throw new Error("No files found for boundary scan; did you run `npm run build`?");

const offences = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  const normalised = text.replace(/\\/g, "/");
  for (const token of forbiddenTokens) {
    if (normalised.includes(token)) offences.push({ file, token });
  }
  // Reject absolute paths that point inside the source repo (other than the
  // consumer's own root, which is a legitimate build location).
  if (normalised.includes(repoAbsolutePrefix)) offences.push({ file, token: repoAbsolutePrefix });
}

if (offences.length) {
  for (const { file, token } of offences) console.error(`Forbidden package boundary reference in ${file}: ${token}`);
  throw new Error(`Consumer boundary scan failed: ${offences.length} offence(s) across scanned roots ${scanRoots.join(", ")}.`);
}

console.log(`Consumer boundary scan passed: scanned ${files.length} file(s) across ${scanRoots.join(", ")}; public root import only.`);
