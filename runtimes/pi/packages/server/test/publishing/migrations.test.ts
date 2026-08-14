/**
 * TASK-004 migration runner tests. Requires the local test database; skipped
 * automatically when it is unreachable.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";

const SCHEMA = `pub_test_${process.pid}_${Date.now().toString(36)}`;
const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";

async function probe(): Promise<boolean> {
	try {
		const client = new PostgresClient({ url: PG_URL, connectTimeoutSeconds: 2, searchPath: SCHEMA });
		await client.ping();
		await client.close();
		return true;
	} catch {
		return false;
	}
}

const pgUp = await probe();

describe.skipIf(!pgUp)("migration runner", () => {
	let client: PostgresClient;

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		// Reset the shared test schema so each run starts empty.
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
	});

	afterAll(async () => {
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	test("concurrent runners apply each migration exactly once", async () => {
		const [a, b] = await Promise.all([runMigrations(client), runMigrations(client)]);
		const total = [...a.applied, ...b.applied].filter((file) => file === "0001_publishing_core.sql");
		expect(total).toHaveLength(1);
	});

	test("creates the control-plane tables from section 26.2", async () => {
		const rows = await client.run(
			"select table_name from information_schema.tables where table_schema = current_schema()",
		);
		const names = rows.map((row) => String(row.table_name));
		for (const table of [
			"tenants",
			"agent_definitions",
			"published_apps",
			"published_app_versions",
			"embed_launch_keys",
		]) {
			expect(names).toContain(table);
		}
	});

	test("re-running is a no-op", async () => {
		const result = await runMigrations(client);
		expect(result.applied).toEqual([]);
	});

	test("a failing migration rolls back atomically", async () => {
		const dir = await mkdtemp(join(tmpdir(), "skdy-migrate-"));
		try {
			await writeFile(join(dir, "0001_bad.sql"), "CREATE TABLE broken_syntax_2 (id integer");
			await writeFile(join(dir, "0002_good.sql"), "CREATE TABLE good_after_bad (id integer);");
			await expect(runMigrations(client, { migrationsDir: dir })).rejects.toThrow();

			const recorded = await client.run("select version from _migrations where version = '0001_bad.sql'");
			expect(recorded).toHaveLength(0);
			const goodTables = await client.run(
				"select table_name from information_schema.tables where table_schema = current_schema() and table_name = 'good_after_bad'",
			);
			expect(goodTables).toHaveLength(0);

			// After fixing the bad file both pending migrations apply in order.
			await writeFile(join(dir, "0001_bad.sql"), "CREATE TABLE good_after_fix (id integer);");
			const retry = await runMigrations(client, { migrationsDir: dir });
			expect(retry.applied).toEqual(["0001_bad.sql", "0002_good.sql"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("schema columns match the section 26 baseline", async () => {
		async function columnsOf(table: string): Promise<string[]> {
			const rows = await client.run(
				"select column_name from information_schema.columns where table_schema = current_schema() and table_name = $1",
				table,
			);
			return rows.map((row) => String(row.column_name));
		}
		const tenants = await columnsOf("tenants");
		for (const column of ["id", "name", "status", "created_at", "updated_at"]) {
			expect(tenants).toContain(column);
		}
		const agents = await columnsOf("agent_definitions");
		for (const column of ["id", "tenant_id", "name", "revision", "draft_config", "source_hash"]) {
			expect(agents).toContain(column);
		}
		const apps = await columnsOf("published_apps");
		for (const column of [
			"id",
			"tenant_id",
			"agent_definition_id",
			"public_app_id",
			"status",
			"access_mode",
			"current_version_id",
			"allowed_origins",
			"mutable_policy",
			"created_by",
		]) {
			expect(apps).toContain(column);
		}
		const versions = await columnsOf("published_app_versions");
		for (const column of [
			"id",
			"published_app_id",
			"version_number",
			"source_agent_revision",
			"snapshot",
			"runtime_spec",
			"runtime_spec_hash",
			"status",
			"validation_errors",
			"created_by",
		]) {
			expect(versions).toContain(column);
		}
		const keys = await columnsOf("embed_launch_keys");
		for (const column of [
			"id",
			"published_app_id",
			"key_id",
			"algorithm",
			"public_key_pem",
			"status",
			"not_before",
			"expires_at",
		]) {
			expect(keys).toContain(column);
		}
	});

	test("version uniqueness constraint exists on (published_app_id, version_number)", async () => {
		const rows = await client.run(
			`select tc.constraint_name
			 from information_schema.table_constraints tc
			 where tc.table_schema = current_schema() and tc.table_name = 'published_app_versions'
			   and tc.constraint_type = 'UNIQUE'`,
		);
		const names = rows.map((row) => String(row.constraint_name));
		expect(names.some((name) => name.includes("version_number"))).toBe(true);
	});
});
