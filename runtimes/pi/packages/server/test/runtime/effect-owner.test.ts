/**
 * TASK-020: EffectOwner 单元测试（spec 10.3 完成条件）。
 *
 * 覆盖：LIFO 释放顺序、幂等 close（同一 Promise、disposer 只执行一次）、
 * 单个 disposer 失败不阻止其他清理且错误聚合上报、close 开始后 register 被
 * 拒绝、异步 disposer 顺序。
 */
import { describe, expect, test } from "vitest";
import { createEffectOwner } from "../../src/runtime/effect-owner.ts";

describe("effect owner", () => {
	test("releases effects in LIFO order (last registered first)", async () => {
		const owner = createEffectOwner();
		const order: string[] = [];
		owner.register(() => void order.push("a"));
		owner.register(() => void order.push("b"));
		owner.register(() => void order.push("c"));
		await owner.close();
		expect(order).toEqual(["c", "b", "a"]);
	});

	test("close is idempotent: same promise, disposers run exactly once", async () => {
		const owner = createEffectOwner();
		let runs = 0;
		owner.register(async () => {
			runs += 1;
		});
		const first = owner.close();
		const second = owner.close();
		expect(second).toBe(first);
		await first;
		await second;
		expect(runs).toBe(1);
	});

	test("a failing disposer does not stop the others and errors aggregate", async () => {
		const owner = createEffectOwner();
		const order: string[] = [];
		owner.register(() => {
			throw new Error("boom-a");
		});
		owner.register(async () => {
			order.push("cleanup-ran");
		});
		const closing = owner.close();
		await expect(closing).rejects.toBeInstanceOf(AggregateError);
		await expect(closing).rejects.toThrow(/1 effect\(s\) failed/);
		try {
			await closing;
		} catch (error) {
			expect((error as AggregateError).errors.map((entry) => (entry as Error).message)).toContain("boom-a");
		}
		// 失败不影响后续（更早注册的）disposer 执行。
		expect(order).toEqual(["cleanup-ran"]);
	});

	test("multiple failures are all aggregated", async () => {
		const owner = createEffectOwner();
		owner.register(() => {
			throw new Error("first");
		});
		owner.register(() => {
			throw new Error("second");
		});
		const closing = owner.close();
		await expect(closing).rejects.toBeInstanceOf(AggregateError);
		try {
			await closing;
		} catch (error) {
			const aggregate = error as AggregateError;
			expect(aggregate.errors.map((entry) => (entry as Error).message).sort()).toEqual(["first", "second"]);
		}
	});

	test("registering after close has begun is rejected", async () => {
		const owner = createEffectOwner();
		owner.register(() => {
			// close 执行期间注册 -> 抛错 -> 被聚合上报。
			owner.register(() => {});
		});
		const closing = owner.close();
		await expect(closing).rejects.toBeInstanceOf(AggregateError);
		try {
			await closing;
		} catch (error) {
			expect((error as AggregateError).errors.map((entry) => (entry as Error).message)).toContain(
				"cannot register an effect after close has begun",
			);
		}
	});

	test("awaits async disposers in order", async () => {
		const owner = createEffectOwner();
		const order: string[] = [];
		owner.register(async () => {
			await Promise.resolve();
			order.push("slow");
		});
		owner.register(() => void order.push("fast"));
		await owner.close();
		// LIFO：后注册的 "fast" 先释放，随后等待 "slow" 完成。
		expect(order).toEqual(["fast", "slow"]);
	});

	test("close with no registered effects resolves cleanly", async () => {
		const owner = createEffectOwner();
		await expect(owner.close()).resolves.toBeUndefined();
		await expect(owner.close()).resolves.toBeUndefined();
	});
});
