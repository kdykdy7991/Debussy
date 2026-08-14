/**
 * Sequential SQL migration runner for the publishing/embed persistence layer.
 *
 * - Each migration is a `.sql` file applied inside a transaction; a failure
 *   rolls back both the DDL and the bookkeeping row.
 * - `_migrations` records applied versions; re-running is a no-op.
 * - The whole run executes inside one transaction guarded by
 *   `pg_advisory_xact_lock`, so concurrent runners (e.g. multiple server
 *   processes starting together) serialise and each migration is applied
 *   exactly once; the transaction-scoped lock is released automatically when
 *   the transaction ends and never lingers on a pooled connection.
 * - The default migrations directory is resolved relative to this module so
 *   both `src` (vitest) and `dist` (built server) see the SQL files.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PostgresClient } from "./client.ts";

export interface MigrationOptions {
	/** Directory containing `NNNN_name.sql` files. Defaults to `./migrations`. */
	readonly migrationsDir?: string;
	readonly log?: (message: string) => void;
}

export interface MigrationResult {
	/** Migrations applied by this invocation (empty on re-run). */
	readonly applied: readonly string[];
}

const MIGRATIONS_TABLE = "_migrations";
/** Arbitrary but stable advisory lock key shared by all publishing runners. */
const MIGRATIONS_LOCK_KEY = 0x50495055;

export async function runMigrations(client: PostgresClient, options: MigrationOptions = {}): Promise<MigrationResult> {
	const dir = options.migrationsDir ?? new URL("./migrations/", import.meta.url).pathname;
	const log = options.log ?? (() => {});
	const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
	return client.withDriver(async (sql) => {
		return sql.begin(async (tx) => {
			await tx`select pg_advisory_xact_lock(${MIGRATIONS_LOCK_KEY})`;
			await tx`create table if not exists ${tx(MIGRATIONS_TABLE)} (
				version text primary key,
				applied_at timestamptz not null default now()
			)`;
			const rows = await tx`select version from ${tx(MIGRATIONS_TABLE)}`;
			const applied = new Set(rows.map((row) => String(row.version)));
			const appliedNow: string[] = [];
			for (const file of files) {
				if (applied.has(file)) continue;
				const text = await readFile(join(dir, file), "utf8");
				await tx.unsafe(text);
				await tx`insert into ${tx(MIGRATIONS_TABLE)} (version) values (${file})`;
				log(`applied migration ${file}`);
				appliedNow.push(file);
			}
			return { applied: appliedNow };
		});
	});
}
