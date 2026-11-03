import type { ConversationRuntimeManager } from "../runtime/conversation-runtime-manager.ts";
import { managedTurnExecutor, type TurnExecutor } from "../runtime/turn-executor.ts";

/** A retry keeps its durable Conversation, but must never keep the previous assignment's tool closures. */
export function createOrchestrationTurnExecutor(manager: ConversationRuntimeManager): TurnExecutor {
	const managed = managedTurnExecutor(manager);
	const execute: TurnExecutor = async (input) => {
		try {
			return await managed(input);
		} finally {
			await manager.reset(input.scope.conversationId);
		}
	};
	execute.cancel = managed.cancel;
	return execute;
}
