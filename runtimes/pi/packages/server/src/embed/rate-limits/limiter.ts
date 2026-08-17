/**
 * Layered rate limiter (spec 14 / TASK-034).
 *
 * For one event, every applicable layer (system/tenant/app/principal/
 * conversation) that defines a rule for that dimension is evaluated and the
 * *most restrictive* wins: a request is denied when ANY applicable layer is
 * over its limit. Bucket keys are scoped per layer so limits are counted
 * independently (system-wide vs per-principal, etc.).
 *
 * Backend-failure policy (`fail-open` / `fail-closed`) is applied here. The
 * spec defaults identity & concurrency to `fail-closed`: when the limit store
 * is unavailable we must not silently let everyone through, so the request is
 * denied with a 429-equivalent result (retryable).
 */
import { rateLimited } from "../../publishing/domain/errors.ts";
import type { RateLimitStore } from "./store.ts";
import type { RateLimitDimension, RateLimitsConfig } from "./types.ts";
import { RATE_LIMIT_LAYERS } from "./types.ts";

export type RateLimitFailureMode = "fail-open" | "fail-closed";

export type RateLimitScope = {
	readonly tenantId?: string;
	readonly publishedAppId?: string;
	readonly principalId?: string;
	readonly conversationId?: string;
};

export interface RateLimitKey {
	readonly dimension: RateLimitDimension;
	readonly scope: RateLimitScope;
	/** Extra discriminator for keys without identity (e.g. client IP). */
	readonly discriminator?: string;
}

export interface RateLimitResult {
	readonly allowed: boolean;
	/** 429 retryable when denied by a store failure; `ok` for genuine denials. */
	readonly reason: "ok" | "over-limit" | "store-unavailable";
	/** Remaining allowance at the binding (most restrictive) layer. */
	readonly remaining: number;
	/** Epoch ms when the binding window resets (denials only). */
	readonly resetAt: number;
}

export interface RateLimiterOptions {
	readonly store: RateLimitStore;
	readonly config?: RateLimitsConfig;
	readonly failureMode?: RateLimitFailureMode;
	readonly now?: () => number;
}

export class RateLimiter {
	private readonly store: RateLimitStore;
	private readonly config: RateLimitsConfig;
	private readonly failureMode: RateLimitFailureMode;
	private readonly now: () => number;

	constructor(options: RateLimiterOptions) {
		this.store = options.store;
		this.config = options.config ?? {};
		this.failureMode = options.failureMode ?? "fail-closed";
		this.now = options.now ?? Date.now;
	}

	/**
	 * Evaluate the most restrictive applicable layer for one event. Returns
	 * the decision; does not throw for over-limit.
	 */
	async check(input: RateLimitKey): Promise<RateLimitResult> {
		let binding: { remaining: number; resetAt: number } | null = null;
		let exceeded = false;
		for (const layer of RATE_LIMIT_LAYERS) {
			const rule = this.config[layer]?.[input.dimension];
			const key = bucketKey(layer, input.dimension, input.scope, input.discriminator);
			if (rule === undefined || key === null) continue;
			let count: number;
			let resetAt: number;
			try {
				const window = await this.store.increment(key, rule.windowMs, this.now());
				count = window.count;
				resetAt = window.resetAt;
			} catch {
				// Backend failure: apply the configured policy.
				if (this.failureMode === "fail-open") continue; // allow this layer
				return {
					allowed: false,
					reason: "store-unavailable",
					remaining: 0,
					resetAt: this.now() + 1000,
				};
			}
			const remaining = Math.max(0, rule.count - count);
			if (binding === null || remaining < binding.remaining) {
				binding = { remaining, resetAt };
			}
			if (count > rule.count) exceeded = true;
		}
		if (binding === null) {
			return { allowed: true, reason: "ok", remaining: Infinity, resetAt: this.now() };
		}
		return {
			allowed: !exceeded,
			reason: exceeded ? "over-limit" : "ok",
			remaining: binding.remaining,
			resetAt: binding.resetAt,
		};
	}

	/** Fail-closed convenience: throws `RATE_LIMITED` when not allowed. */
	async guard(input: RateLimitKey): Promise<void> {
		const result = await this.check(input);
		if (!result.allowed) throw rateLimited("Rate limit exceeded, retry after the window resets");
	}
}

/** Build the scoped bucket key for a layer, or null when scope can't key it. */
function bucketKey(
	layer: keyof RateLimitsConfig,
	dimension: RateLimitDimension,
	scope: RateLimitScope,
	discriminator: string | undefined,
): string | null {
	const base = `embed:rl:${dimension}:${layer}`;
	switch (layer) {
		case "system":
			// 无身份的 pre-auth 端点（如 Exchange）以调用方网络身份（IP）区分，
			// 形成按 IP 的 System 层计数（spec 5：匿名 App 必须按 IP/App/Principal 限流）。
			return discriminator === undefined ? base : `${base}:${discriminator}`;
		case "tenant":
			return scope.tenantId === undefined ? null : `${base}:${scope.tenantId}`;
		case "app":
			return scope.publishedAppId === undefined ? null : `${base}:${scope.publishedAppId}`;
		case "principal":
			return scope.principalId === undefined ? null : `${base}:${scope.principalId}`;
		case "conversation":
			return scope.conversationId === undefined ? null : `${base}:${scope.conversationId}`;
	}
}

/** Discriminator that never collides with identity keys. */
export function ipDiscriminator(ip: string | undefined): string {
	return ip === undefined ? "-" : ip;
}
