/**
 * Rate-limit counter store (spec 14 / TASK-034).
 *
 * Stores fixed-window counters keyed by an opaque bucket key. Implementations:
 * - `InMemoryRateLimitStore`: single-process, no external dependency (default
 *   and the fallback for tests / single-node deployments).
 * - `RedisRateLimitStore`: shared across processes so layered limits hold
 *   cluster-wide (spec 14「Cluster-wide」) when Redis is available.
 *
 * Fail-open / fail-closed policy is applied by `RateLimiter`, not here: the
 * store only ever reports success or throws `RateLimitStoreError`.
 */
import { createHash } from "node:crypto";
import type { RedisClient } from "../../persistence/redis/client.ts";

/** Marker for backend failures so callers can apply failure policy. */
export class RateLimitStoreError extends Error {
	readonly cause: unknown;
	constructor(message: string, cause: unknown) {
		super(message);
		this.name = "RateLimitStoreError";
		this.cause = cause;
	}
}

/** Current fixed-window count for a bucket. */
export interface WindowCount {
	readonly count: number;
	/** Epoch ms at which this window resets (inclusive). */
	readonly resetAt: number;
}

export interface RateLimitStore {
	/**
	 * Atomically increment `key` in a `windowMs` window and return the running
	 * count together with the current window's reset time. Throws
	 * `RateLimitStoreError` on backend failure (policy applied by the limiter).
	 */
	increment(key: string, windowMs: number, now?: number): Promise<WindowCount>;
	close(): Promise<void>;
}

/**
 * In-memory fixed-window store. Prunes expired windows lazily on increment.
 * Not shared across processes; sufficient for the MVP defaults and tests.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
	private readonly buckets = new Map<string, { count: number; resetAt: number }>();

	async increment(key: string, windowMs: number, now?: number): Promise<WindowCount> {
		const at = now ?? Date.now();
		const existing = this.buckets.get(key);
		if (existing !== undefined) {
			if (at < existing.resetAt) {
				existing.count += 1;
				return { count: existing.count, resetAt: existing.resetAt };
			}
			// Window elapsed: overwrite (reuse the slot to bound memory).
			existing.count = 1;
			existing.resetAt = at + windowMs;
			return { count: existing.count, resetAt: existing.resetAt };
		}
		const resetAt = at + windowMs;
		this.buckets.set(key, { count: 1, resetAt });
		return { count: 1, resetAt };
	}

	sweepExpired(now = Date.now()): void {
		for (const [key, entry] of this.buckets) {
			if (now >= entry.resetAt) this.buckets.delete(key);
		}
	}

	async close(): Promise<void> {
		this.buckets.clear();
	}
}

const REDIS_KEY_PREFIX = "skdy:embed:rl:";

function ratioKey(key: string, windowMs: number): string {
	const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
	return `${REDIS_KEY_PREFIX}${hash}:${windowMs}`;
}

/**
 * Redis fixed-window store. Each increment runs an atomic Lua INCR + expire
 * so concurrent requests cannot overshoot the limit. Backend failures throw
 * `RateLimitStoreError`; the limiter applies the configured failure policy.
 */
export function createRedisRateLimitStore(redis: RedisClient): RateLimitStore {
	return {
		async increment(key, windowMs, now) {
			const rk = ratioKey(key, windowMs);
			try {
				// Lua: INCR; on first touch set expiry to one window from NOW.
				// The (windowMs - 1) edge is acceptable for fixed-window limits.
				const res = (await redis.run(
					"EVAL",
					`local c = redis.call("INCR", KEYS[1])
if c == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
return c`,
					1,
					rk,
					windowMs,
				)) as number;
				const at = now ?? Date.now();
				return { count: Number(res), resetAt: at + windowMs };
			} catch (error) {
				throw new RateLimitStoreError("rate-limit store backend failed", error);
			}
		},
		async close() {
			// RedisClient is owned by the caller (start.ts); nothing to close here.
		},
	};
}
