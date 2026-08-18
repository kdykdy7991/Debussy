/**
 * Idempotency-Key generator for admin write operations (MVP-03).
 *
 * Every POST/PUT/DELETE the workbench issues must carry an `Idempotency-Key`
 * header so that network retries, double-clicks, or tab re-opens do not
 * create duplicate resources. Keys are bound to the current browser session
 * via `crypto.randomUUID()` and intentionally do NOT depend on the admin
 * token (so a fresh unlock after a 401 still produces non-colliding keys).
 *
 * The helper is pure: it does not write to Storage, URL, or console.
 */

export interface IdempotencyKeyOptions {
	/** Logical operation name. Used as a short prefix so server logs are greppable. */
	readonly operation: string;
}

/**
 * Generate a fresh Idempotency-Key. The `op_<short>_` prefix helps the
 * server-side idempotency store categorise replays; the UUID suffix is the
 * real identifier.
 */
export function newIdempotencyKey(options: IdempotencyKeyOptions): string {
	const uuid =
		typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: `ik_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
	const slug =
		options.operation
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.slice(0, 16) || "op";
	return `op_${slug}_${uuid}`;
}
