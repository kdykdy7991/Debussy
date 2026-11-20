import type { ConversationRuntimeManager } from "../runtime/conversation-runtime-manager.ts";
import { managedTurnExecutor, type TurnExecutor } from "../runtime/turn-executor.ts";
import { OrchestrationError } from "./contracts.ts";
import type { OrchestrationStore } from "./store.ts";

/** A retry keeps its durable Conversation, but must never keep the previous assignment's tool closures. */
export function createOrchestrationTurnExecutor(
	manager: ConversationRuntimeManager,
	store: OrchestrationStore,
): TurnExecutor {
	const managed = managedTurnExecutor(manager, async ({ scope }) => {
		const rows = await store.client.run(
			"select 1 from orchestration_work_items w join orchestration_assignments a on a.work_item_id=w.id and a.tenant_id=w.tenant_id where w.tenant_id=$1 and w.conversation_id=$2 and a.turn_id=$3 and w.state='running' and a.state='running'",
			store.tenantId,
			scope.conversationId,
			scope.turnId ?? null,
		);
		if (!rows[0]) throw new OrchestrationError(409, "RUN_CANCELLED", "任务已终止");
	});
	const execute: TurnExecutor = async (input) => {
		try {
			return await managed({
				...input,
				onLlmTrace: async (trace) => {
					if (input.scope.turnId === undefined) return;
					await store.recordLlmTrace(input.scope.conversationId, input.scope.turnId, trace);
				},
			});
		} finally {
			await manager.reset(input.scope.conversationId);
		}
	};
	execute.cancel = managed.cancel;
	return execute;
}
