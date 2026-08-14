/**
 * RuntimeOwner（spec AD-13 / TASK-021）。
 *
 * 首期单节点实现 `LocalRuntimeOwner`：本节点拥有全部 Runtime，`epoch` 固定
 * 为 1。接口保留 `nodeId`/`epoch` 与 `lease` 边界，使未来多节点 Lease 可以
 * 在不改变 ConversationRuntimeManager 调用方的前提下接入（spec 9/15：
 * 接口不得依赖「永远只有一个节点」的假设）。
 */
import { uuidv7 } from "../publishing/domain/ids.ts";

export interface RuntimeLease {
	readonly nodeId: string;
	/** 单调递增的 owner 代次；重启/切换 owner 时变化，供 Lease 校验。 */
	readonly epoch: number;
}

export interface RuntimeOwner {
	readonly lease: RuntimeLease;
	/** 本 owner 是否仍持有该 conversation 的执行权（未来多节点用）。 */
	isCurrent(conversationId: string): boolean;
}

export function createLocalRuntimeOwner(): RuntimeOwner {
	const lease: RuntimeLease = { nodeId: uuidv7(), epoch: 1 };
	return {
		lease,
		isCurrent: () => true,
	};
}
