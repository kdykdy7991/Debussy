/**
 * Canonical serialisation + SHA-256 for the RuntimeSpec Compiler (TASK-010).
 *
 * `canonicalJson` recursively sorts object keys so identical semantic values
 * always produce identical bytes; `sha256Hex` is the resulting content hash
 * stored in `published_app_versions.runtime_spec_hash` (spec 26.4 allows
 * sampling a recompute to detect drift).
 */
import { createHash } from "node:crypto";

/** Stable JSON serialisation: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
	}
	if (value === undefined) return "null";
	return JSON.stringify(value);
}

export function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}
