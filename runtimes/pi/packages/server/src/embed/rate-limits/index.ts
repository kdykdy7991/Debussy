/**
 * 分层限流 + 并发槽组合入口（spec 14 / TASK-034）。
 *
 * `EmbedLimits` 捆绑：分层最严格 RateLimiter（System/Tenant/App/Principal/
 * Conversation 各维度独立计数，身份/并发故障默认 fail-closed）与进程级并发
 * Turn 槽（容量可配，超限立即 429，无等待队列）。`createEmbedLimits` 提供
 * 默认（内存计数 + spec 默认规则 + 30 并发槽）；生产可从 compose 注入
 * Redis store（cluster-wide）与自定义规则/容量。
 */

import type { RateLimitFailureMode } from "./limiter.ts";
import { RateLimiter } from "./limiter.ts";
import type { ConcurrencySlots } from "./slot.ts";
import { createConcurrencySlots } from "./slot.ts";
import type { RateLimitStore } from "./store.ts";
import { InMemoryRateLimitStore } from "./store.ts";
import type { RateLimitsConfig } from "./types.ts";
import { DEFAULT_RATE_LIMITS } from "./types.ts";

export interface EmbedLimits {
	readonly limiter: RateLimiter;
	readonly turnSlots: ConcurrencySlots;
}

export interface CreateEmbedLimitsOptions {
	readonly store?: RateLimitStore;
	readonly config?: RateLimitsConfig;
	readonly failureMode?: RateLimitFailureMode;
	readonly turnSlotCapacity?: number;
}

export function createEmbedLimits(options: CreateEmbedLimitsOptions = {}): EmbedLimits {
	return {
		limiter: new RateLimiter({
			store: options.store ?? new InMemoryRateLimitStore(),
			config: options.config ?? DEFAULT_RATE_LIMITS,
			failureMode: options.failureMode,
		}),
		turnSlots: createConcurrencySlots({ capacity: options.turnSlotCapacity ?? 30 }),
	};
}
