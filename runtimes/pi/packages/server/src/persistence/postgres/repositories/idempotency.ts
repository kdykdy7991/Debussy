/**
 * Idempotency repository (spec section 26.2 `idempotency_records`).
 *
 * `begin` claims the slot for `(operation, idempotency_key)` inside one
 * transaction so concurrent callers cannot double-claim:
 *
 * - fresh insert wins and becomes `running` (`claimed`);
 * - a completed slot with the same request hash replays the stored response;
 * - a different request hash under the same key is a 409 (`conflict`);
 * - a still-running slot is `in_progress` (caller waits/retries);
 * - a `running` slot whose `expires_at` has passed (or a `failed` slot) is
 *   reclaimed atomically with a conditional UPDATE, so of N concurrent
 *   reclaimers exactly one wins and the rest see `in_progress`.
 *
 * The reclaim policy is the explicit stale-lock recovery required by
 * TASK-008: expired `running` slots never block retries forever.
 */
import type { PrincipalId, TenantId } from "../../../publishing/domain/ids.ts";
import type {
	IdempotencyBeginResult,
	IdempotencyRecord,
	IdempotencyRepository,
	IdempotencyScope,
} from "../../../publishing/repositories.ts";
import type { PostgresClient, SqlParameter } from "../client.ts";
import { txRows } from "./tx.ts";

const COLUMNS =
	"tenant_id, principal_id, operation, idempotency_key, request_hash, state, response_status, response_body, expires_at, created_at";

function rowToRecord(row: Record<string, unknown>): IdempotencyRecord {
	return {
		tenantId: row.tenant_id as TenantId,
		principalId: row.principal_id as PrincipalId,
		operation: String(row.operation),
		idempotencyKey: String(row.idempotency_key),
		requestHash: String(row.request_hash),
		state: row.state as IdempotencyRecord["state"],
		responseStatus: row.response_status === null ? null : Number(row.response_status),
		responseBody: row.response_body,
		expiresAt: row.expires_at as Date,
		createdAt: row.created_at as Date,
	};
}

export function createIdempotencyRepository(client: PostgresClient): IdempotencyRepository {
	return {
		async begin(scope, operation, idempotencyKey, requestHash, ttlMs) {
			const expiresAt = new Date(Date.now() + ttlMs);
			return client.transaction(async (tx): Promise<IdempotencyBeginResult> => {
				const inserted = await txRows(
					tx,
					`insert into idempotency_records
					 (tenant_id, principal_id, operation, idempotency_key, request_hash, state, expires_at)
					 values ($1, $2, $3, $4, $5, 'running', $6)
					 on conflict do nothing
					 returning tenant_id`,
					scope.tenantId,
					scope.principalId,
					operation,
					idempotencyKey,
					requestHash,
					expiresAt,
				);
				if (inserted.length === 1) return { outcome: "claimed" };

				const existing = await txRows(
					tx,
					`select ${COLUMNS} from idempotency_records
					 where tenant_id = $1 and principal_id = $2 and operation = $3 and idempotency_key = $4`,
					scope.tenantId,
					scope.principalId,
					operation,
					idempotencyKey,
				);
				if (existing.length !== 1) return { outcome: "conflict" };
				const record = rowToRecord(existing[0]);
				if (record.requestHash !== requestHash) return { outcome: "conflict" };
				if (record.state === "completed") return { outcome: "replay", record };
				if (record.state === "running") {
					// Stale-lock recovery: an expired running slot can be
					// reclaimed; a live one is still executing elsewhere.
					if (record.expiresAt.getTime() > Date.now()) return { outcome: "in_progress" };
					const reclaimed = await txRows(
						tx,
						`update idempotency_records
						 set state = 'running', request_hash = $5, response_status = null, response_body = null, expires_at = $6
						 where tenant_id = $1 and principal_id = $2 and operation = $3 and idempotency_key = $4
						   and state = 'running' and expires_at < now()
						 returning tenant_id`,
						scope.tenantId,
						scope.principalId,
						operation,
						idempotencyKey,
						requestHash,
						expiresAt,
					);
					return reclaimed.length === 1 ? { outcome: "claimed" } : { outcome: "in_progress" };
				}
				// failed: a retry of the same request may reclaim the slot.
				const reclaimed = await txRows(
					tx,
					`update idempotency_records
					 set state = 'running', request_hash = $5, response_status = null, response_body = null, expires_at = $6
					 where tenant_id = $1 and principal_id = $2 and operation = $3 and idempotency_key = $4
					   and state = 'failed'
					 returning tenant_id`,
					scope.tenantId,
					scope.principalId,
					operation,
					idempotencyKey,
					requestHash,
					expiresAt,
				);
				return reclaimed.length === 1 ? { outcome: "claimed" } : { outcome: "in_progress" };
			});
		},
		async complete(scope, operation, idempotencyKey, responseStatus, responseBody) {
			await client.run(
				`update idempotency_records
				 set state = 'completed', response_status = $5, response_body = $6
				 where tenant_id = $1 and principal_id = $2 and operation = $3 and idempotency_key = $4
				   and state = 'running'`,
				scope.tenantId,
				scope.principalId,
				operation,
				idempotencyKey,
				responseStatus,
				responseBody as SqlParameter,
			);
		},
		async fail(scope, operation, idempotencyKey) {
			await client.run(
				`update idempotency_records
				 set state = 'failed'
				 where tenant_id = $1 and principal_id = $2 and operation = $3 and idempotency_key = $4
				   and state = 'running'`,
				scope.tenantId,
				scope.principalId,
				operation,
				idempotencyKey,
			);
		},
		async sweepExpired(scope, now = new Date()) {
			const rows = await client.run(
				`update idempotency_records
				 set state = 'failed'
				 where tenant_id = $1 and principal_id = $2 and state = 'running' and expires_at < $3
				 returning tenant_id`,
				scope.tenantId,
				scope.principalId,
				now,
			);
			return rows.length;
		},
	};
}

export type { IdempotencyScope };
