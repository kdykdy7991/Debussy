import type { DebugRepositories } from "../../../publishing/debug/types.ts";
import type { PostgresClient } from "../client.ts";
import { createDebugConversationSummaryRepository } from "./debug-conversation-summaries.ts";
import { createDebugConversationEventRepository, createDebugConversationRepository } from "./debug-conversations.ts";

/** Build the self-contained Debug Conversation repositories over one Postgres client. */
export function createDebugRepositories(client: PostgresClient): DebugRepositories {
	return {
		conversations: createDebugConversationRepository(client),
		events: createDebugConversationEventRepository(client),
		summaries: createDebugConversationSummaryRepository(client),
	};
}
