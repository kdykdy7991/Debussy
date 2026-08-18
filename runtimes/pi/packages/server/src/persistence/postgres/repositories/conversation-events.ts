/**
 * Conversation event repository (spec section 26.3 / WB-007).
 *
 * `append` runs the sequence bump, the payload byte write and the event
 * insert in ONE transaction:
 * - sequence is allocated via `UPDATE ... RETURNING` (never read-then-increment)
 * - the conversation counter columns (`event_count`, `event_bytes`,
 *   `turn_count`) are advanced in the same statement
 * - if the insert fails the whole transaction rolls back, so a failed append
 *   can never leave a hole, an inflated counter, or advance `last_event_sequence`
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
	AdminConversationEventListParams,
	ConversationEventInput,
	ConversationEventListParams,
	ConversationEventRecord,
	ConversationEventRepository,
	OwnerScope,
	TenantScope,
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
		payloadBytes: Number(row.payload_bytes ?? 0),
		createdAt: row.created_at as Date,
	};
}

export function computePayloadBytes(payload: unknown): number {
	// JSON round-trip keeps the exact wire shape; encoder handles escaping.
	const json = JSON.stringify(payload);
	return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

export function createConversationEventRepository(client: PostgresClient): ConversationEventRepository {
	return {
		async append(scope: OwnerScope, input: ConversationEventInput) {
			const eventId = newConversationEventId();
			const eventSchemaVersion = input.eventSchemaVersion ?? 1;
			const turnId = input.turnId ?? null;
			const payloadBytes = input.payloadBytes ?? computePayloadBytes(input.payload);
			return client.transaction(async (tx) => {
				// Advance the conversation counter in the SAME UPDATE that bumps
				// the sequence. The RETURNING clause lets us fail fast when the
				// conversation is missing / out of scope. `turn_count` is only
				// incremented when the row does not already record this turn
				// id (first event for the turn wins).
				const bumped = await txRows(
					tx,
					`update conversations
					 set last_event_sequence = last_event_sequence + 1,
					     event_count = event_count + 1,
					     event_bytes = event_bytes + $5,
					     turn_count = turn_count + case
					         when $6::uuid is null then 0
					         else (select case when exists (
					             select 1 from conversation_events ce
					             where ce.conversation_id = conversations.id
					               and ce.turn_id = $6::uuid
					         ) then 0 else 1 end)
					     end,
					     updated_at = now(),
					     last_active_at = now()
					 where id = $1 and tenant_id = $2 and published_app_id = $3 and owner_principal_id = $4
					   and deleted_at is null
					 returning last_event_sequence`,
					input.conversationId,
					scope.tenantId,
					scope.publishedAppId,
					scope.principalId,
					payloadBytes,
					turnId,
				);
				if (bumped.length !== 1) return undefined;
				const sequence = Number(bumped[0].last_event_sequence);
				await txRows(
					tx,
					`insert into conversation_events
					 (id, tenant_id, published_app_id, conversation_id, sequence, event_type,
					  event_schema_version, turn_id, payload, payload_bytes, created_at)
					 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
					eventId,
					scope.tenantId,
					scope.publishedAppId,
					input.conversationId,
					sequence,
					input.eventType,
					eventSchemaVersion,
					turnId,
					input.payload as SqlParameter,
					payloadBytes,
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
					payloadBytes,
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
		async listByConversation(params: AdminConversationEventListParams) {
			const limit = Math.min(Math.max(params.limit, 1), 500);
			// Tenant-scoped admin variant of `list`: a conversationId is
			// globally unique, so tenant + conversation is sufficient scope —
			// cross-owner (any principal in the tenant) is allowed,
			// cross-tenant is not. Empty page = indistinguishable from no
			// events (uniform 404).
			const rows = await client.run(
				`select e.* from conversation_events e
				 join conversations c on c.id = e.conversation_id and c.published_app_id = e.published_app_id
				 where e.conversation_id = $1 and e.tenant_id = $2
				   and c.deleted_at is null
				   and e.sequence > $3
				 order by e.sequence asc
				 limit $4`,
				params.conversationId,
				params.scope.tenantId,
				params.afterSequence ?? 0,
				limit,
			);
			return rows.map((row) => rowToRecord(row));
		},
		async countErrors(scope: TenantScope) {
			const rows = await client.run(
				`select count(*)::int as cnt from conversation_events
				 where tenant_id = $1 and event_type in ('turn.failed', 'tool.error')`,
				scope.tenantId,
			);
			return Number(rows[0]?.cnt ?? 0);
		},
	};
}
