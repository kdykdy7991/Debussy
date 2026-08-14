/**
 * Conversation event repository (spec section 26.3).
 *
 * `append` runs the sequence bump and the event insert in ONE transaction:
 * the sequence is allocated with `UPDATE ... RETURNING` (never read-then-
 * increment), and if the insert fails the whole transaction rolls back, so a
 * failed append can never leave a hole or advance `last_event_sequence`.
 * Every read embeds the full ownership scope; a bare event-id lookup is
 * impossible.
 */
import {
	type ConversationEventId,
	type ConversationId,
	newConversationEventId,
	type PublishedAppId,
	type TenantId,
	type TurnId,
} from "../../../publishing/domain/ids.ts";
import type {
	ConversationEventInput,
	ConversationEventListParams,
	ConversationEventRecord,
	ConversationEventRepository,
	OwnerScope,
} from "../../../publishing/repositories.ts";
import type { PostgresClient, SqlParameter } from "../client.ts";
import { txRows } from "./tx.ts";

function rowToRecord(row: Record<string, unknown>): ConversationEventRecord {
	return {
		eventId: row.id as ConversationEventId,
		tenantId: row.tenant_id as TenantId,
		publishedAppId: row.published_app_id as PublishedAppId,
		conversationId: row.conversation_id as ConversationId,
		sequence: Number(row.sequence),
		eventType: String(row.event_type),
		eventSchemaVersion: Number(row.event_schema_version),
		turnId: (row.turn_id as TurnId | null) ?? null,
		payload: row.payload,
		createdAt: row.created_at as Date,
	};
}

export function createConversationEventRepository(client: PostgresClient): ConversationEventRepository {
	return {
		async append(scope: OwnerScope, input: ConversationEventInput) {
			const eventId = newConversationEventId();
			const eventSchemaVersion = input.eventSchemaVersion ?? 1;
			const turnId = input.turnId ?? null;
			return client.transaction(async (tx) => {
				const bumped = await txRows(
					tx,
					`update conversations
					 set last_event_sequence = last_event_sequence + 1, updated_at = now(), last_active_at = now()
					 where id = $1 and tenant_id = $2 and published_app_id = $3 and owner_principal_id = $4
					   and deleted_at is null
					 returning last_event_sequence`,
					input.conversationId,
					scope.tenantId,
					scope.publishedAppId,
					scope.principalId,
				);
				if (bumped.length !== 1) return undefined;
				const sequence = Number(bumped[0].last_event_sequence);
				await txRows(
					tx,
					`insert into conversation_events
					 (id, tenant_id, published_app_id, conversation_id, sequence, event_type,
					  event_schema_version, turn_id, payload, created_at)
					 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
					eventId,
					scope.tenantId,
					scope.publishedAppId,
					input.conversationId,
					sequence,
					input.eventType,
					eventSchemaVersion,
					turnId,
					input.payload as SqlParameter,
				);
				return {
					eventId,
					tenantId: scope.tenantId,
					publishedAppId: scope.publishedAppId,
					conversationId: input.conversationId,
					sequence,
					eventType: input.eventType,
					eventSchemaVersion,
					turnId,
					payload: input.payload,
					createdAt: new Date(),
				};
			});
		},
		async list(scope: OwnerScope, conversationId: ConversationId, params: ConversationEventListParams) {
			const limit = Math.min(Math.max(params.limit, 1), 500);
			// The events table has no owner column, so the conversation's
			// ownership is enforced via a join: out-of-scope callers see an
			// empty page, indistinguishable from a conversation with no events.
			const rows = await client.run(
				`select e.* from conversation_events e
				 join conversations c on c.id = e.conversation_id and c.published_app_id = e.published_app_id
				 where e.conversation_id = $1 and e.tenant_id = $2 and e.published_app_id = $3
				   and c.owner_principal_id = $4 and c.deleted_at is null
				   and e.sequence > $5
				 order by e.sequence asc
				 limit $6`,
				conversationId,
				scope.tenantId,
				scope.publishedAppId,
				scope.principalId,
				params.afterSequence ?? 0,
				limit,
			);
			return rows.map((row) => rowToRecord(row));
		},
	};
}
