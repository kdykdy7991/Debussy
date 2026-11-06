import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("./aaas-contract-hashes.json", import.meta.url), "utf8"));
let changed = false;
for (const [path, expected] of Object.entries(manifest)) {
	const content = await readFile(new URL(`../${path}`, import.meta.url));
	const actual = createHash("sha256").update(content).digest("hex");
	if (actual !== expected) {
		console.error(`Agent API contract review required: ${path}\n  expected ${expected}\n  actual   ${actual}`);
		changed = true;
	}
}
if (changed) {
	console.error(`Review API behavior, OpenAPI and integration guide, run the contract test, then update scripts/aaas-contract-hashes.json. Root: ${root}`);
	process.exitCode = 1;
} else {
	console.log("Agent API contract review hashes match.");
}
