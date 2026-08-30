/**
 * ConversationRuntimeManager（spec AD-06 / TASK-021）。
 *
 * 管理当前节点上的活跃 ConversationRuntime：opening 去重（并发 acquire 同一
 * Conversation 只创建一次）、active map、空闲 TTL 回收、节点退出 drain。
 * Runtime 生命周期不再由 HTTP/WebSocket Connection 决定——连接断开不销毁
 * 仍在执行且策略允许继续的 Turn（禁止继续条件）。
 *
 * 依赖注入 `opener`（把 RuntimeSpec + Scope 打开为 ConversationRuntime），
 * 不直接耦合 PiRuntimeAdapter；空闲 TTL 用可注入时钟，测试可手动推进。
 */
import type { ConversationId } from "../publishing/domain/ids.ts";
import type { RuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import type { ConversationRuntime } from "./conversation-runtime.ts";
import type { ScopeContext } from "./scope-context.ts";

export type RuntimeOpener = (spec: RuntimeSpec, scope: ScopeContext) => Promise<ConversationRuntime>;

export interface ConversationRuntimeManagerOptions {
	readonly opener: RuntimeOpener;
	/** 空闲 TTL（ms）；默认 1_200_000（PD-14，20 分钟）。 */
	readonly idleTtlMs?: number;
	/** 可注入时钟（测试用）；默认 Date.now。 */
	readonly now?: () => number;
	/** 后台关闭/清理失败时的回调。 */
	readonly onError?: (error: unknown) => void;
	/** 是否自动周期回收空闲 Runtime；测试传 false 以便手动 sweep。 */
	readonly autoSweep?: boolean;
}

export type AcquireResult = {
	readonly runtime: ConversationRuntime;
	/** 本次调用是否实际创建（并发去重时仅一个为 true）。 */
	readonly created: boolean;
};

interface ActiveEntry {
	readonly runtime: ConversationRuntime;
	lastActiveAt: number;
}

export interface ConversationRuntimeManager {
	/** 获取（或创建）一个 Conversation 的活跃 Runtime；close 后拒绝。 */
	acquire(spec: RuntimeSpec, scope: ScopeContext): Promise<AcquireResult>;
	/** 当前活跃 Runtime（无则 undefined）；不改变活跃状态。 */
	get(conversationId: ConversationId): ConversationRuntime | undefined;
	/** Turn 结束信号：刷新活跃时间。 */
	release(conversationId: ConversationId): void;
	/** 回收空闲超时的 Runtime（幂等 close + 移除）；等待全部 close 完成。 */
	sweepIdle(now?: number): Promise<void>;
	/** 节点退出 drain：关闭全部活跃 Runtime（幂等）。 */
	drain(): Promise<void>;
	/** drain + 关闭管理器；之后 acquire 拒绝。 */
	close(): Promise<void>;
}

export function createConversationRuntimeManager(
	options: ConversationRuntimeManagerOptions,
): ConversationRuntimeManager {
	const idleTtlMs = options.idleTtlMs ?? 1_200_000;
	const now = options.now ?? Date.now;
	const onError = options.onError ?? (() => {});
	const active = new Map<ConversationId, ActiveEntry>();
	const opening = new Map<ConversationId, Promise<ConversationRuntime>>();
	let closed = false;
	let drainPromise: Promise<void> | undefined;
	let sweepTimer: ReturnType<typeof setInterval> | undefined;

	// 生产环境自动周期回收（unref 不阻塞进程退出）；测试传 autoSweep: false。
	if (options.autoSweep !== false && typeof setInterval === "function") {
		sweepTimer = setInterval(() => {
			void sweepIdle().catch(onError);
		}, idleTtlMs);
		sweepTimer.unref?.();
	}

	function sweepIdle(nowAt = now()): Promise<void> {
		const closing: Promise<void>[] = [];
		for (const [conversationId, entry] of active) {
			if (nowAt - entry.lastActiveAt >= idleTtlMs) {
				active.delete(conversationId);
				closing.push(entry.runtime.close().catch(onError));
			}
		}
		return Promise.all(closing).then(() => {});
	}

	async function acquire(spec: RuntimeSpec, scope: ScopeContext): Promise<AcquireResult> {
		if (closed) throw new Error("conversation runtime manager is closed");
		const conversationId = scope.conversationId;
		const existing = active.get(conversationId);
		if (existing !== undefined) {
			// TURN-TASK：capability 须按每个 Turn 的目标 Agent Revision 重新
			// resolve。Runtime 打开时即冻结了该版本的 skills/MCP/tools；若当前
			// Turn 的目标 publishedAppVersionId 与缓存 Runtime 已打开的版本不同
			// （版本升级/切换），不得复用旧 Runtime 的能力集合——关闭并从当前
			// spec 重建，避免从历史会话继承 tool/skill 能力。
			if (existing.runtime.scope.publishedAppVersionId !== scope.publishedAppVersionId) {
				active.delete(conversationId);
				await existing.runtime.close().catch(onError);
				return { runtime: await openOnce(spec, scope, conversationId), created: true };
			}
			existing.lastActiveAt = now();
			return { runtime: existing.runtime, created: false };
		}
		const pending = opening.get(conversationId);
		if (pending !== undefined) {
			return { runtime: await pending, created: false };
		}
		const created = openOnce(spec, scope, conversationId);
		return { runtime: await created, created: true };
	}

	function openOnce(
		spec: RuntimeSpec,
		scope: ScopeContext,
		conversationId: ConversationId,
	): Promise<ConversationRuntime> {
		const promise = options
			.opener(spec, scope)
			.then((runtime) => {
				active.set(conversationId, { runtime, lastActiveAt: now() });
				return runtime;
			})
			.finally(() => {
				opening.delete(conversationId);
			});
		opening.set(conversationId, promise);
		return promise;
	}

	async function drain(): Promise<void> {
		if (drainPromise !== undefined) return drainPromise;
		drainPromise = (async () => {
			if (sweepTimer !== undefined) {
				clearInterval(sweepTimer);
				sweepTimer = undefined;
			}
			const runtimes = [...active.values()];
			active.clear();
			const results = await Promise.allSettled(runtimes.map((entry) => entry.runtime.close()));
			for (const result of results) {
				if (result.status === "rejected") onError(result.reason);
			}
		})();
		return drainPromise;
	}

	return {
		acquire,
		get(conversationId) {
			return active.get(conversationId)?.runtime;
		},
		release(conversationId) {
			const entry = active.get(conversationId);
			if (entry !== undefined) entry.lastActiveAt = now();
		},
		sweepIdle,
		drain,
		async close() {
			await drain();
			closed = true;
		},
	};
}
