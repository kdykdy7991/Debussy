/**
 * PostgreSQL implementations of the scoped publishing repositories.
 *
 * Every query embeds the resource scope (`tenant_id` and where applicable
 * `published_app_id` / `owner_principal_id`) in the WHERE clause; there are no
 * bare-id public methods. Row mapping keeps the domain records typed.
 */

import type { PublishingRepositories } from "../../../publishing/repositories.ts";
import type { PostgresClient } from "../client.ts";
import { createAgentDefinitionRepository } from "./agent-definitions.ts";
import { createAttachmentRepository } from "./attachments.ts";
import { createAuditEventRepository } from "./audit.ts";
import { createConversationEventRepository } from "./conversation-events.ts";
import { createConversationReasoningRepository } from "./conversation-reasoning.ts";
import { createConversationSummaryRepository } from "./conversation-summaries.ts";
import { createConversationRepository } from "./conversations.ts";
import { createIdempotencyRepository } from "./idempotency.ts";
import { createLaunchKeyRepository } from "./launch-keys.ts";
import { createMcpSecretRepository } from "./mcp-secrets.ts";
import { createMcpServerRepository } from "./mcp-servers.ts";
import { createPrincipalRepository } from "./principals.ts";
import { createPublishedAppVersionRepository } from "./published-app-versions.ts";
import { createPublishedAppRepository } from "./published-apps.ts";
import { createSkillRepository } from "./skills.ts";
import { createTenantRepository } from "./tenants.ts";

/** Build all scoped repositories over one Postgres client. */
export function createPublishingRepositories(client: PostgresClient): PublishingRepositories {
	return {
		tenants: createTenantRepository(client),
		agentDefinitions: createAgentDefinitionRepository(client),
		skills: createSkillRepository(client),
		mcpServers: createMcpServerRepository(client),
		mcpSecrets: createMcpSecretRepository(client),
		publishedApps: createPublishedAppRepository(client),
		publishedAppVersions: createPublishedAppVersionRepository(client),
		principals: createPrincipalRepository(client),
		conversations: createConversationRepository(client),
		conversationReasoning: createConversationReasoningRepository(client),
		events: createConversationEventRepository(client),
		summaries: createConversationSummaryRepository(client),
		idempotency: createIdempotencyRepository(client),
		audit: createAuditEventRepository(client),
		launchKeys: createLaunchKeyRepository(client),
		attachments: createAttachmentRepository(client),
	};
}

export type { PublishingRepositories } from "../../../publishing/repositories.ts";
