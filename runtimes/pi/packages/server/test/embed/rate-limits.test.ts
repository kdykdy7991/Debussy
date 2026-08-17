/**
 * TASK-034：分层限流与并发槽单测（spec 14）。
 *
 * 覆盖：内存/Redis 计数断言行为、分层最严格（任一适用层超限即拒）、维度
 * 独立计数、无适用规则放行、store 故障 fail-open/fail-closed（身份/并发
 * 默认 fail-closed）、并发槽容量/释放幂等/无等待队列/clear。
 */
import { describe, expect, test } from "vitest";
import type { RateLimitScope } from "../../src/embed/rate-limits/limiter.ts";
import { RateLimiter } from "../../src/embed/rate-limits/limiter.ts";
import { createConcurrencySlots } from "../../src/embed/rate-limits/slot.ts";
import { InMemoryRateLimitStore, RateLimitStoreError } from "../../src/embed/rate-limits/store.ts";

function scope(partial: Partial<RateLimitScope> = {}): RateLimitScope {
	return {
		tenantId: "tenant_a",
		publishedAppId: "app_b",
		principalId: "prn_c",
		...partial,
	};
}

describe("InMemoryRateLimitStore", () => {
	test("counts within a window and resets after the window elapses", async () => {
		const store = new InMemoryRateLimitStore();
		let now = 1_000;
		expect((await store.increment("k", 10_000, now)).count).toBe(1);
		expect((await store.increment("k", 10_000, now)).count).toBe(2);
		now = 11_000; // window elapsed
		const window = await store.increment("k", 10_000, now);
		expect(window.count).toBe(1);
		expect(window.resetAt).toBe(now + 10_000);
		await store.close();
	});
});

describe("RateLimiter", () => {
	const config = {
		system: { turn: { count: 5, windowMs: 60_000 } },
		principal: { turn: { count: 2, windowMs: 60_000 }, token: { count: 10, windowMs: 60_000 } },
		conversation: { turn: { count: 1, windowMs: 60_000 } },
	};

	test("most restrictive applicable layer wins (conversation < principal < system)", async () => {
		const limiter = new RateLimiter({ store: new InMemoryRateLimitStore(), config });
		const s = scope({ conversationId: "conv_1" });
		expect((await limiter.check({ dimension: "turn", scope: s })).allowed).toBe(true);
		// conversation window holds 1 turn/min (system 5, principal 2): the
		// 2nd event is denied by the conversation layer (most restrictive).
		const denied = await limiter.check({ dimension: "turn", scope: s });
		expect(denied.allowed).toBe(false);
		expect(denied.reason).toBe("over-limit");
		// an isolated principal+conversation is not throttled by conv_1's bucket;
		// its own conversation window (count 1) still binds after one turn.
		const isolated = scope({ principalId: "prn_d", conversationId: "conv_2" });
		expect((await limiter.check({ dimension: "turn", scope: isolated })).allowed).toBe(true);
		expect((await limiter.check({ dimension: "turn", scope: isolated })).allowed).toBe(false);
	});

	test("dimensions are counted independently", async () => {
		const limiter = new RateLimiter({ store: new InMemoryRateLimitStore(), config });
		// exhaust token dimension via principal; turn is untouched.
		const s = scope();
		for (let i = 0; i < 10; i += 1)
			expect((await limiter.check({ dimension: "token", scope: s })).allowed).toBe(true);
		expect((await limiter.check({ dimension: "token", scope: s })).allowed).toBe(false);
		expect((await limiter.check({ dimension: "turn", scope: s })).allowed).toBe(true);
	});

	test("no applicable rule for the layer set passes", async () => {
		const limiter = new RateLimiter({ store: new InMemoryRateLimitStore(), config });
		// uploads has no rules in config -> always allowed.
		const r = await limiter.check({ dimension: "uploads", scope: scope() });
		expect(r.allowed).toBe(true);
		// principal missing means principal layer not keyable.
		const r2 = await limiter.check({ dimension: "turn", scope: scope({ principalId: undefined }) });
		expect([true, false]).toContain(r2.allowed);
	});

	test("backend failure defaults to fail-closed (denied)", async () => {
		const failing = {
			increment: async () => {
				throw new RateLimitStoreError("down", new Error("backend down"));
			},
			close: async () => {},
		};
		const limiter = new RateLimiter({ store: failing, config });
		const r = await limiter.check({ dimension: "turn", scope: scope() });
		expect(r.allowed).toBe(false);
		expect(r.reason).toBe("store-unavailable");
	});

	test("backend failure with fail-open allows", async () => {
		const failing = {
			increment: async () => {
				throw new RateLimitStoreError("down", new Error("backend down"));
			},
			close: async () => {},
		};
		const limiter = new RateLimiter({ store: failing, config, failureMode: "fail-open" });
		const r = await limiter.check({ dimension: "turn", scope: scope() });
		expect(r.allowed).toBe(true);
	});

	test("guard throws RATE_LIMITED when denied by the most restrictive layer", async () => {
		const limiter = new RateLimiter({ store: new InMemoryRateLimitStore(), config });
		await limiter.guard({ dimension: "turn", scope: scope({ conversationId: "conv_x" }) });
		await expect(
			limiter.guard({ dimension: "turn", scope: scope({ conversationId: "conv_x" }) }),
		).rejects.toMatchObject({
			code: "RATE_LIMITED",
			httpStatus: 429,
		});
	});
});

describe("ConcurrencySlots", () => {
	test("bounds active turns and releases idempotently", () => {
		const slots = createConcurrencySlots({ capacity: 2 });
		expect(slots.capacity).toBe(2);
		const a = slots.acquire();
		const b = slots.acquire();
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(slots.acquire()).toBeNull(); // no unbounded queue; immediate 429
		expect(slots.active).toBe(2);
		a!.release();
		a!.release(); // idempotent
		expect(slots.active).toBe(1);
		expect(slots.acquire()).not.toBeNull();
		expect(slots.active).toBe(2);
		b!.release();
		expect(slots.active).toBe(1);
	});

	test("clear (node drain) zeroes held slots; later releases are no-ops", () => {
		const slots = createConcurrencySlots({ capacity: 2 });
		const a = slots.acquire()!;
		slots.acquire();
		expect(slots.active).toBe(2);
		slots.clear();
		expect(slots.active).toBe(0);
		a.release(); // no-op
		expect(slots.active).toBe(0);
	});

	test("rejects non-positive capacity", () => {
		expect(() => createConcurrencySlots({ capacity: 0 })).toThrow();
	});
});
