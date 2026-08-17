/**
 * Rate-limit model types (spec 14 / TASK-034).
 *
 * Layered rate limiting: for one event each applicable layer
 * (system -> tenant -> app -> principal -> conversation) may impose its own
 * limit; the *most restrictive* layer wins (a request is denied when ANY
 * applicable layer is over its limit). Different dimensions (connections,
 * exchange, token issuance, turn, uploads) are counted separately so a burst
 * of one action cannot exhaust a different dimension's budget.
 */
export type RateLimitDimension = "connections" | "exchange" | "token" | "turn" | "uploads";

/** A rate-limit layer, ordered from coarsest to finest. */
export type RateLimitLayer = "system" | "tenant" | "app" | "principal" | "conversation";

/** One rate-limit rule: at most `count` events per `windowMs` per bucket key. */
export interface RateLimitRule {
	readonly count: number;
	readonly windowMs: number;
}

/** Per-layer rulesets keyed by dimension. A missing rule = no limit at that layer. */
export type RateLimitsConfig = Partial<Record<RateLimitLayer, Partial<Record<RateLimitDimension, RateLimitRule>>>>;

/** All layers, coarse to fine (used to evaluate in a deterministic order). */
export const RATE_LIMIT_LAYERS: readonly RateLimitLayer[] = [
	"system",
	"tenant",
	"app",
	"principal",
	"conversation",
] as const;

/** Every dimension (used for defaults / validation). */
export const RATE_LIMIT_DIMENSIONS: readonly RateLimitDimension[] = [
	"connections",
	"exchange",
	"token",
	"turn",
	"uploads",
] as const;

/**
 * Layered rate limits sensible for the MVP. Ordered coarse to fine; the
 * limiter takes the most restrictive applicable layer.
 */
export const DEFAULT_RATE_LIMITS: RateLimitsConfig = {
	system: {
		connections: { count: 1000, windowMs: 60_000 },
		exchange: { count: 300, windowMs: 60_000 },
		token: { count: 1000, windowMs: 60_000 },
		turn: { count: 2000, windowMs: 60_000 },
		uploads: { count: 2000, windowMs: 60_000 },
	},
	tenant: {
		connections: { count: 800, windowMs: 60_000 },
		exchange: { count: 200, windowMs: 60_000 },
		token: { count: 800, windowMs: 60_000 },
		turn: { count: 1500, windowMs: 60_000 },
		uploads: { count: 1500, windowMs: 60_000 },
	},
	principal: {
		connections: { count: 50, windowMs: 60_000 },
		exchange: { count: 20, windowMs: 60_000 },
		token: { count: 100, windowMs: 60_000 },
		turn: { count: 60, windowMs: 60_000 },
		uploads: { count: 120, windowMs: 60_000 },
	},
	conversation: {
		turn: { count: 10, windowMs: 60_000 },
		uploads: { count: 120, windowMs: 60_000 },
	},
};
