/**
 * Phase-3.6 Token Accounting.
 *
 * Splits the real request cost into the two parts Debussy can/must reason about:
 *
 *   A. Working Context  — Summary + recent structured Conversation transcript.
 *                         This is what Compaction can shrink.
 *   B. Runtime overhead — system prompt, Skill instructions, MCP/builtin tool
 *                         schemas, context files/snippets/guidelines and other
 *                         fixed request content. Compaction CANNOT shrink it.
 *
 * We never replace the Working-Context estimate with a bare `usage.input`: the
 * two are combined the RIGHT way —
 *
 *   measuredRuntimeOverhead
 *     = actualInputTokens(lastTurnWithUsage)   (real, provider-measured)
 *       - estimatedWorkingContextTokens(same request)
 *     = max(0, ...)
 *
 * so the budget reserves exactly the system/skills/tools cost we cannot compress,
 * instead of assuming a fixed 2048.
 *
 * Usage semantics intentionally reuse Pi's own overflow semantic
 * (`ai/src/utils/overflow.ts`): actual input = `input + cacheRead`. `input` is
 * the non-cached prompt tokens and `cacheRead` is the prompt-cache tokens — they
 * partition the request input, so summing them does not double count. `cacheWrite`
 * (suffix-cache write) is NOT part of the input that competes for the window and
 * is therefore excluded. No second provider-specific parser is implemented here.
 */

/** The subset of the protocol `Usage` this module reads. */
export interface UsageTokens {
	readonly input?: number;
	readonly cacheRead?: number;
	/** Deliberately documented but excluded from the actual-input sum. */
	readonly cacheWrite?: number;
}

/**
 * FULL input tokens of a request, matching Pi's `isContextOverflow` semantic
 * (`message.usage.input + message.usage.cacheRead`). Input + cacheRead partition
 * the request input — safe to sum, never double-counts the cached portion.
 */
export function actualInputTokens(usage: UsageTokens | null | undefined): number {
	if (usage === undefined || usage === null) return 0;
	return (usage.input ?? 0) + (usage.cacheRead ?? 0);
}

/**
 * Fraction of the effective window reserved as runtime overhead when no provider
 * usage is available. A documented CONSERVATIVE bound (scales with the window),
 * NOT a claim about the true overhead — we compact earlier, never trust a
 * too-big budget to avoid overflow.
 */
export const FALLBACK_RUNTIME_OVERHEAD_RATIO = 0.2;

/** Space kept for the as-yet-unknown next user message (turn/end maintenance). */
export const DEFAULT_NEXT_INPUT_RESERVE = 2_048;

/** Small error buffer on top of the explicit reservations. */
export const DEFAULT_SAFETY_MARGIN = 512;

/** Conservative runtime-overhead reserve when measurement is unavailable. */
export function conservativeRuntimeOverhead(effectiveWindow: number): number {
	return Math.round(effectiveWindow * FALLBACK_RUNTIME_OVERHEAD_RATIO);
}
