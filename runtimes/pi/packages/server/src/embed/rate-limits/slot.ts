/**
 * Process-wide concurrency slots (spec 14 / TASK-034).
 *
 * Bounds the number of concurrent in-flight turns across every conversation
 * in this process (the spec's turn concurrency cap is process-wide, not
 * per-app). Acquisition is non-blocking: when capacity is exhausted the caller
 * gets `null` so it can answer `RATE_LIMITED` (429) immediately. There is no
 * unbounded waiting queue (禁止继续条件). Slots are released exactly once and
 * release is idempotent so EffectOwner-style cleanup is safe.
 */
export interface TurnSlot {
	/** Idempotent; safe to call more than once. */
	release(): void;
}

export interface ConcurrencySlotsOptions {
	readonly capacity?: number;
}

export interface ConcurrencySlots {
	readonly capacity: number;
	/** Number of slots currently held. */
	readonly active: number;
	/** Acquire a slot, or `null` when all slots are held (no queue). */
	acquire(): TurnSlot | null;
	/** Zero out all held slots (node drain); callers' release stays a no-op. */
	clear(): void;
}

export function createConcurrencySlots(options: ConcurrencySlotsOptions = {}): ConcurrencySlots {
	const capacity = options.capacity ?? 30;
	if (!Number.isInteger(capacity) || capacity < 1) {
		throw new Error(`concurrency slot capacity must be a positive integer, got: ${capacity}`);
	}
	let held = 0;
	return {
		get capacity() {
			return capacity;
		},
		get active() {
			return held;
		},
		acquire() {
			if (held >= capacity) return null;
			held += 1;
			let released = false;
			return {
				release() {
					if (released) return;
					released = true;
					if (held > 0) held -= 1;
				},
			};
		},
		clear() {
			held = 0;
		},
	};
}
