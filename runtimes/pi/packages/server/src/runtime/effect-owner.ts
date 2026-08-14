/**
 * EffectOwner（spec 10.3，TASK-020）。
 *
 * 每个 ConversationRuntime 必须统一拥有并释放全部资源（PiSessionRuntime、
 * 模型流/AbortController、工具句柄、订阅、Timer、listener 等）。本类提供
 * 最小实现：
 *
 * - `register` 注册同步/异步 disposer；close 开始后注册被拒绝。
 * - `close` 按 LIFO（后注册先释放）逐个执行；单个 disposer 失败不阻止
 *   其他清理；错误聚合为 `AggregateError` 统一上报；幂等（重复调用返回
 *   同一 Promise）。
 */
export type Disposer = () => void | Promise<void>;

export interface EffectOwner {
	/** 注册一个 disposer；close 已开始时抛错。 */
	register(disposer: Disposer): void;
	/** LIFO 释放全部注册的 disposer；幂等。 */
	close(): Promise<void>;
}

export function createEffectOwner(): EffectOwner {
	const disposers: Disposer[] = [];
	let closing: Promise<void> | undefined;

	return {
		register(disposer) {
			if (closing !== undefined) {
				throw new Error("cannot register an effect after close has begun");
			}
			disposers.push(disposer);
		},
		close() {
			if (closing !== undefined) return closing;
			// 先赋值 closing 再执行释放体（经微任务延后），保证 close 开始后
			// register 立即被拒绝（否则同步 disposer 会在赋值前执行）。
			closing = Promise.resolve().then(async () => {
				const errors: unknown[] = [];
				// LIFO：后注册的资源先释放（spec 10.3：逆序释放）。
				for (let i = disposers.length - 1; i >= 0; i -= 1) {
					const disposer = disposers[i];
					if (disposer === undefined) continue;
					try {
						await disposer();
					} catch (error) {
						errors.push(error);
					}
				}
				disposers.length = 0;
				if (errors.length > 0) {
					throw new AggregateError(errors, `${errors.length} effect(s) failed to dispose`);
				}
			});
			return closing;
		},
	};
}
