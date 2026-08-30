/**
 * PostgreSQL implementation of the Debug Conversation repositories (Phase 1).
 *
 * Self-contained: it only touches the `debug_conversations` and
 * `debug_conversation_events` tables and never the Production conversation
 * schema. The event `append` mirrors the Production atomic-sequence machine
 * (bump `last_event_sequence` + insert in ONE transaction) but against the
 * Debug parent table.
 */

import { computeDebugPayloadBytes } from "../../../publishing/debug/payload.ts";
import type {
	DebugConversationEventListParams,
	DebugConversationEventRecord,
	DebugConversationRecord,
	DebugConversationRef,
	DebugConversationRepository,
	DebugConversationScope,
} from "../../../publishing/debug/types.ts";
import type {
	AgentDefinitionId,
	DebugConversationId,
	PrincipalId,
	TenantId,
	TurnId,
} from "../../../publishing/domain/ids.ts";
import { newDebugConversationEventId } from "../../../publishing/domain/ids.ts";
import type { PostgresClient, SqlParameter } from "../client.ts";
import { txRows } from "./tx.ts";

function rowToConversation(row: Record<string, unknown>): DebugConversationRecord {
	return {
		debugConversationId: row.id as DebugConversationId,
		tenantId: row.tenant_id as TenantId,
		agentId: (row.agent_id as AgentDefinitionId | null) ?? null,
		ownerPrincipalId: row.owner_principal_id as PrincipalId,
		status: row.status as DebugConversationRecord["status"],
		lastEventSequence: Number(row.last_event_sequence),
		createdAt: row.created_at as Date,
		lastActiveAt: row.last_active_at as Date,
	};
}

function rowToEvent(row: Record<string, unknown>): DebugConversationEventRecord {
	return {
		eventId: row.id as DebugConversationEventRecord["eventId"],
		debugConversationId: row.debug_conversation_id as DebugConversationId,
		sequence: Number(row.sequence),
		eventType: String(row.event_type),
		eventSchemaVersion: Number(row.event_schema_version),
		turnId: (row.turn_id as TurnId | null) ?? null,
		payload: row.payload,
		createdAt: row.created_at as Date,
	};
}

export function createDebugConversationRepository(client: PostgresClient): DebugConversationRepository {
	return {
		async insert(record) {
			await client.run(
				`insert into debug_conversations
				 (id, tenant_id, agent_id, owner_principal_id, status, last_event_sequence, created_at, last_active_at)
				 values ($1, $2, $3, $4, $5, $6, $7, $8)`,
				record.debugConversationId,
				record.tenantId,
				record.agentId,
				record.ownerPrincipalId,
				record.status,
				record.lastEventSequence,
				record.createdAt,
				record.lastActiveAt,
			);
		},
		async getRecentActive(scope: DebugConversationScope) {
			const rows = await client.run(
				`select * from debug_conversations
				 where tenant_id = $1 and agent_id is not distinct from $3 and owner_principal_id = $2
				   and status = 'active'
				 order by last_active_at desc, id desc
				 limit 1`,
				scope.tenantId,
				scope.ownerPrincipalId,
				scope.agentId,
			);
			return rows.length === 1 ? rowToConversation(rows[0]!) : undefined;
		},
		async getByRef(scope: DebugConversationRef) {
			const rows = await client.run(
				`select * from debug_conversations
				 where id = $1 and tenant_id = $2
				 limit 1`,
				scope.debugConversationId,
				scope.tenantId,
			);
			return rows.length === 1 ? rowToConversation(rows[0]!) : undefined;
		},
		async setStatus(scope: DebugConversationRef, status) {
			const rows = await client.run(
				`update debug_conversations set status = $3
				 where id = $1 and tenant_id = $2 and status = 'active'
				 returning id`,
				scope.debugConversationId,
				scope.tenantId,
				status,
			);
			return rows.length === 1;
		},
	};
}

export function createDebugConversationEventRepository(client: PostgresClient): DebugConversationEventRepository {
	return {
		async append(scope, conversationId, input) {
			const eventId = newDebugConversationEventId();
			const eventSchemaVersion = input.eventSchemaVersion ?? 1;
			const turnId = input.turnId ?? null;
			const payloadBytes = input.payloadBytes ?? computeDebugPayloadBytes(input.payload);
			return client.transaction(async (tx) => {
				const bumped = await txRows(
					tx,
					`update debug_conversations
					 set last_event_sequence = last_event_sequence + 1, last_active_at = now()
					 where id = $1 and tenant_id = $2 and status = 'active'
					 returning last_event_sequence`,
					conversationId,
					scope.tenantId,
				);
				if (bumped.length !== 1) return undefined;
				const sequence = Number(bumped[0]!.last_event_sequence);
				await txRows(
					tx,
					`insert into debug_conversation_events
					 (id, debug_conversation_id, sequence, event_type, event_schema_version,
					  turn_id, payload, payload_bytes, created_at)
					 values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
					eventId,
					conversationId,
					sequence,
					input.eventType,
					eventSchemaVersion,
					turnId,
					input.payload as SqlParameter,
					payloadBytes,
				);
				return {
					eventId,
					debugConversationId: conversationId,
					sequence,
					eventType: input.eventType,
					eventSchemaVersion,
					turnId,
					payload: input.payload,
					createdAt: new Date(),
				} satisfies DebugConversationEventRecord;
			});
		},
		async list(scope, params) {
			const limit = Math.min(Math.max(params.limit, 1), 10_000);
			const rows = await client.run(
				`select e.* from debug_conversation_events e
				 join debug_conversations c on c.id = e.debug_conversation_id
				 where e.debug_conversation_id = $1 and c.tenant_id = $2
				   and e.sequence > $3
				 order by e.sequence asc
				 limit $4`,
				scope.debugConversationId,
				scope.tenantId,
				params.afterSequence ?? 0,
				limit,
			);
			return rows.map((row) => rowToEvent(row));
		},
	};
}
