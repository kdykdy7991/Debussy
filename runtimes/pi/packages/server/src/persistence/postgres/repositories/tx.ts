/**
 * Transaction query helper shared by repositories that must run several
 * statements atomically (spec 26.3 event append, idempotency claim). The
 * postgres.js transaction handle accepts the same parameters as `unsafe`;
 * the cast mirrors `PostgresClient.run`.
 */
import type { TransactionSql } from "postgres";
import type { SqlParameter } from "../client.ts";

export async function txRows(
	tx: TransactionSql,
	query: string,
	...parameters: readonly SqlParameter[]
): Promise<readonly Record<string, unknown>[]> {
	const rows = await tx.unsafe(query, parameters as unknown as Parameters<typeof tx.unsafe>[1]);
	return rows as readonly Record<string, unknown>[];
}
