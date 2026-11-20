import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";

const url = process.env.PI_ORCHESTRATION_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";
const dir = new URL("../../src/persistence/postgres/migrations/", import.meta.url).pathname;

test("0034 preserves the platform default, pinned Keys and atomic repeatable migration", async () => {
	const schema = `active_migration_${process.pid}_${Date.now()}`;
	const client = new PostgresClient({ url, searchPath: schema });
	const older = await mkdtemp(join(tmpdir(), "aaas-pre-0034-"));
	const later = await mkdtemp(join(tmpdir(), "aaas-0034-"));
	const tenant = randomUUID(), primary = randomUUID(), other = randomUUID(), empty = randomUUID();
	const defaultOld = randomUUID(), defaultNew = randomUUID(), otherOld = randomUUID(), otherNew = randomUUID(), key = randomUUID();
	try {
		await client.run(`create schema ${schema}`);
		const files = (await readdir(dir)).filter((name) => name.endsWith(".sql"));
		for (const name of files.filter((name) => name < "0034")) await copyFile(join(dir, name), join(older, name));
		await runMigrations(client, { migrationsDir: older });
		await client.run("insert into tenants(id,name,status) values ($1,'migration-test','active')", tenant);
		for (const [id, name] of [[primary, "default"], [other, "other"], [empty, "empty"]])
			await client.run("insert into orchestration_configurations(id,tenant_id,name,draft,draft_revision) values ($1,$2,$3,'{}',1)", id, tenant, name);
		for (const [id, config, revision] of [[defaultOld, primary, 1], [defaultNew, primary, 2], [otherOld, other, 1], [otherNew, other, 2]])
			await client.run("insert into orchestration_versions(id,tenant_id,configuration_id,snapshot,source_draft_revision,runtime_spec,runtime_spec_hash) values ($1,$2,$3,'{}',$4,'{}','hash')", id, tenant, config, revision);
		await client.run("insert into aaas_platform_configuration(tenant_id,configuration_id,orchestration_version_id) values ($1,$2,$3)", tenant, primary, defaultOld);
		await client.run("insert into aaas_api_keys(id,tenant_id,name,secret_hash,orchestration_version_id) values ($1,$2,'pinned',$3,$4)", key, tenant, "a".repeat(64), otherOld);
		const migration = "0034_aaas_configuration_follow.sql";
		await copyFile(join(dir, migration), join(later, migration));
		await writeFile(join(later, "9999_forced_failure.sql"), "select 1/0;");
		await expect(runMigrations(client, { migrationsDir: later })).rejects.toThrow();
		expect((await client.run("select column_name from information_schema.columns where table_schema=$1 and table_name='orchestration_configurations' and column_name='active_version_id'", schema))).toHaveLength(0);
		expect(await client.run("select version from _migrations where version like '0034%'")).toHaveLength(0);
		await rm(join(later, "9999_forced_failure.sql"));
		expect((await runMigrations(client, { migrationsDir: later })).applied).toEqual([migration]);
		const rows = await client.run("select id,active_version_id from orchestration_configurations where tenant_id=$1", tenant);
		const active = Object.fromEntries(rows.map((row) => [String(row.id), row.active_version_id]));
		expect(active).toEqual({ [primary]: defaultOld, [other]: otherNew, [empty]: null });
		expect((await client.run("select orchestration_version_id,orchestration_configuration_id from aaas_api_keys where id=$1", key))[0]).toMatchObject({ orchestration_version_id: otherOld, orchestration_configuration_id: null });
		await client.run("update orchestration_configurations set active_version_id=$2 where id=$1", other, otherOld);
		expect((await runMigrations(client, { migrationsDir: later })).applied).toEqual([]);
		expect((await client.run("select active_version_id from orchestration_configurations where id=$1", other))[0]?.active_version_id).toBe(otherOld);
		await expect(client.run("update orchestration_configurations set active_version_id=$2 where id=$1", primary, otherNew)).rejects.toThrow();
	} finally {
		await client.run(`drop schema if exists ${schema} cascade`);
		await client.close();
		await rm(older, { recursive: true, force: true });
		await rm(later, { recursive: true, force: true });
	}
}, 30000);
