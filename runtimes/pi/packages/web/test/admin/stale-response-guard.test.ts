/**
 * M1: 过期请求保护（`createStaleResponseGuard`）单元测试。
 *
 * 验证以下场景（覆盖组件层同款逻辑）：
 *
 * 1. `begin()` 每次递增代号，并 abort 上一个未完成 ticket。
 * 2. "第二个请求先 resolve，最后仍显示第二个请求结果"：
 *    ticket #1 commit 晚于 ticket #2 commit 时，仅 #2 写 state；
 *    ticket #1 的 commit 静默丢弃。
 * 3. abort 后 commit 不再执行（即使代号仍最新）。
 * 4. cancel() 取消当前活动 ticket，commit 不再执行。
 * 5. `signal` 通过 `fetch` 透传到 `AbortSignal.aborted`，由调用方 fetch
 *    自行决定是否抛 AbortError。
 */
import { describe, expect, it } from "vitest";
import { createStaleResponseGuard } from "../../src/admin/data-state.ts";

describe("createStaleResponseGuard (M1)", () => {
	it("begin() increments generation and aborts the previous ticket", () => {
		const guard = createStaleResponseGuard();
		const t1 = guard.begin();
		const t2 = guard.begin();
		expect(t1.generation).toBe(1);
		expect(t2.generation).toBe(2);
		expect(t1.signal.aborted).toBe(true);
		expect(t2.signal.aborted).toBe(false);
		expect(guard.latest).toBe(2);
	});

	it("commit() from a stale ticket is silently dropped; latest ticket wins", () => {
		// 场景：父组件触发 `load(afterSequence=0)` → ticket #1
		//      立即 `load(afterSequence=50)` → ticket #2（abort #1）
		//      ticket #2 先 resolve → 写 state
		//      ticket #1 resolve（理论上应已被 abort，但若 mock 实现漏 abort）→
		//      此时 #1 commit 必须**不写** state。
		const guard = createStaleResponseGuard();
		const t1 = guard.begin();
		const t2 = guard.begin();

		const writes: string[] = [];
		t2.commit(() => writes.push(`second(${t2.generation})`));
		t1.commit(() => writes.push(`first(${t1.generation})`));

		expect(writes).toEqual(["second(2)"]);
	});

	it("abort() makes commit() a no-op", () => {
		const guard = createStaleResponseGuard();
		const ticket = guard.begin();
		ticket.abort();
		const writes: string[] = [];
		ticket.commit(() => writes.push("x"));
		expect(writes).toEqual([]);
	});

	it("cancel() aborts the active ticket and commit() becomes no-op", () => {
		const guard = createStaleResponseGuard();
		const ticket = guard.begin();
		guard.cancel();
		expect(ticket.signal.aborted).toBe(true);
		const writes: string[] = [];
		ticket.commit(() => writes.push("x"));
		expect(writes).toEqual([]);
	});

	it("signal can be passed to fetch; AbortController propagates via fetch spec", () => {
		const guard = createStaleResponseGuard();
		const ticket = guard.begin();
		// 模拟组件把 signal 透传给 fetch；fetch 行为依赖运行时，不在这里断言；
		// 仅证明 signal 自身是 AbortSignal 且未 abort。
		expect(ticket.signal).toBeInstanceOf(AbortSignal);
		expect(ticket.signal.aborted).toBe(false);
	});

	it("begin() after cancel() restarts a fresh generation sequence", () => {
		const guard = createStaleResponseGuard();
		const t1 = guard.begin();
		expect(t1.generation).toBe(1);
		guard.cancel();
		const t2 = guard.begin();
		expect(t2.generation).toBe(2);
		expect(t2.signal.aborted).toBe(false);
	});
});
