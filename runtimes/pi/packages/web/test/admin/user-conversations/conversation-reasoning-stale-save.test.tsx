/**
 * M1 reasoning：过期保存响应保护（R7 阻断项 #3）。
 *
 * 验证场景：用户在 conv_A 上发起保存 → 在保存尚未返回时切换到 conv_B →
 * conv_A 的保存响应不能覆盖 conv_B 的 UI 状态。
 *
 * 这里用 `StaleResponseGuard` 自身的语义做断言（`begin/cancel/commit/abort`），
 * 把组件替换为最小复现。组件级 wire 验证（`api.putReasoning(..., signal)` 把
 * AbortSignal 传到 fetch）在 `test/admin/conversations-api.test.ts` 已覆盖。
 */
import { describe, expect, it, vi } from "vitest";
import { createStaleResponseGuard } from "../../../src/admin/data-state.ts";

describe("stale save: putReasoning + StaleResponseGuard", () => {
	it("begin/cancel sequence: 第二次 begin abort 旧 controller，commit 旧 ticket 是 no-op", () => {
		const guard = createStaleResponseGuard();
		const t1 = guard.begin();
		const t2 = guard.begin();
		// 第二次 begin() 必须 abort t1 的 controller；保证旧 fetch 不再 setState。
		expect(t1.signal.aborted).toBe(true);
		expect(t2.signal.aborted).toBe(false);
		expect(guard.latest).toBe(2);
	});

	it("cancel() aborts current generation's controller", () => {
		const guard = createStaleResponseGuard();
		const t1 = guard.begin();
		guard.cancel();
		expect(t1.signal.aborted).toBe(true);
		// 取消后 begin 不应复用旧 controller。
		const t2 = guard.begin();
		expect(t2.signal.aborted).toBe(false);
	});

	it("commit() on stale ticket is a no-op (caller-side guard)", () => {
		const guard = createStaleResponseGuard();
		const t1 = guard.begin();
		guard.cancel();
		const updater = vi.fn();
		// t1 已 stale，commit 必须不调用 updater。
		t1.commit(updater);
		expect(updater).not.toHaveBeenCalled();
	});

	/**
	 * 关键场景（阻断项 #3 真实路径）：
	 *
	 * 用户在 conv_A 触发保存，await 还没 resolve 就切换 conversation：
	 *   1. conversationId 变化触发组件卸载；
	 *   2. 卸载 cleanup 调 `saveGuard.cancel()` → 旧 ticket 的 signal abort；
	 *   3. 旧 `putReasoning` 的 await 在 signal.aborted=true 时走 AbortError 分支，
	 *      **不**调 setState，不覆盖新 conversation 的 state。
	 *
	 * 这里用 promise + abort 模拟：发起一个"挂起"的 putReasoning，cancel 后
	 * 验证它真的被 abort（且后续即使 promise resolve，组件也忽略）。
	 */
	it("save-guard cancel aborts the in-flight save（上一会话 putReasoning 不写新会话 state）", async () => {
		const guard = createStaleResponseGuard();
		const ticket = guard.begin();

		// 模拟旧 save 正在 in-flight
		const stalePut = new Promise<void>((_resolve, reject) => {
			ticket.signal.addEventListener("abort", () => {
				reject(new DOMException("aborted", "AbortError"));
			});
		});
		// 用户切换 conversation → cancel 旧 save
		guard.cancel();
		expect(ticket.signal.aborted).toBe(true);

		// 旧 save 必须以 AbortError 失败；UI 应当据此识别并**不**写 state。
		const setStateForNewConversation = vi.fn();
		await stalePut
			.then(() => setStateForNewConversation("loaded"))
			.catch((err: unknown) => {
				if (err instanceof DOMException && err.name === "AbortError") {
					// 这是预期的早退路径：组件识别 abort 后**不**写 state
					return;
				}
				throw err;
			});
		expect(setStateForNewConversation).not.toHaveBeenCalled();
	});

	/**
	 * R8 阻断项 #1 反向证明：stateGuard 与 saveGuard 严格独立——
	 * `begin()` 一个不会 abort 另一个的 in-flight ticket。R7 的死锁
	 * 是因为 `loadCapability` 与 `loadState` 共用 `loadGuard`；R8
	 * 删除 capability 加载后，`stateGuard` 只守护 `getReasoning`，
	 * `saveGuard` 只守护 `putReasoning`，互不影响。
	 */
	it("stateGuard 与 saveGuard 严格独立：begin() 互不取消", () => {
		const stateGuard = createStaleResponseGuard();
		const saveGuard = createStaleResponseGuard();
		// 并发两个 save 期间发起一个 state load。
		const saveTicket1 = saveGuard.begin();
		const saveTicket2 = saveGuard.begin();
		const stateTicket = stateGuard.begin();

		// 三个 ticket 都未 abort。
		expect(saveTicket1.signal.aborted).toBe(true); // 第二次 begin abort 第一次（同 guard 内）
		expect(saveTicket2.signal.aborted).toBe(false);
		expect(stateTicket.signal.aborted).toBe(false); // 不同 guard，互不影响

		// 反向：cancel stateGuard 不会影响 saveGuard。
		stateGuard.cancel();
		expect(stateTicket.signal.aborted).toBe(true);
		expect(saveTicket2.signal.aborted).toBe(false);
	});
});
