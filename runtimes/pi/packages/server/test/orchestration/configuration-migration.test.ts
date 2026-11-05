import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";

const url = process.env.PI_ORCHESTRATION_TEST_DATABASE_URL;
test.skipIf(!url)(
	"0027 preserves pre-existing contexts, contracts, idempotency hashes and results",
	async () => {
		const schema = `config_upgrade_${process.pid}_${Date.now()}`;
		const client = new PostgresClient({ url: url!, searchPath: schema });
		const older = await mkdtemp(join(tmpdir(), "pre-0027-"));
		const dir = new URL("../../src/persistence/postgres/migrations/", import.meta.url).pathname;
		const tenant = randomUUID(),
			app = randomUUID(),
			version = randomUUID(),
			agent = randomUUID(),
			integration = randomUUID();
		try {
			await client.run(`create schema ${schema}`);
			await Promise.all(
				(await readdir(dir))
					.filter((name) => name.endsWith(".sql") && name < "0027")
					.map((name) => copyFile(join(dir, name), join(older, name))),
			);
			await runMigrations(client, { migrationsDir: older });
			await client.run("insert into tenants(id,name,status) values ($1,'history','active')", tenant);
			await client.run(
				"insert into agent_definitions(id,tenant_id,name,revision,draft_config,created_by) values ($1,$2,'history',1,'{}',$2)",
				agent,
				tenant,
			);
			await client.run(
				"insert into published_apps(id,tenant_id,agent_definition_id,public_app_id,name,status,access_mode,created_by) values ($1,$2,$3,$4,'history','active','anonymous',$2)",
				app,
				tenant,
				agent,
				`pub_${app}`,
			);
			await client.run(
				"insert into published_app_versions(id,tenant_id,published_app_id,version_number,source_agent_revision,snapshot,runtime_spec,runtime_spec_hash,status,created_by) values ($1,$2,$3,1,1,'{}','{}',$4,'ready',$2)",
				version,
				tenant,
				app,
				"a".repeat(64),
			);
			await client.run(
				"insert into orchestration_integrations(id,tenant_id,published_app_id,published_app_version_id,name,secret_hash,settings) values ($1,$2,$3,$4,'history',$5,'{}')",
				integration,
				tenant,
				app,
				version,
				"b".repeat(64),
			);
			for (const [index, origin, prompt] of [
				[0, "aaas", "historical override"],
				[1, "aaas", null],
				[2, "orchestration", null],
			] as const) {
				const principal = randomUUID(),
					conversation = randomUUID(),
					work = randomUUID(),
					event = randomUUID(),
					credential = randomUUID(),
					assignment = randomUUID();
				await client.run(
					"insert into principals(id,tenant_id,published_app_id,principal_type,subject_hash,status) values ($1,$2,$3,'service',$4,'active')",
					principal,
					tenant,
					app,
					String(index).repeat(64),
				);
				await client.run(
					"insert into conversations(id,tenant_id,published_app_id,published_app_version_id,owner_principal_id,status) values ($1,$2,$3,$4,$5,'active')",
					conversation,
					tenant,
					app,
					version,
					principal,
				);
				await client.run(
					"insert into orchestration_work_items(id,tenant_id,integration_id,alarm_id,state,configuration_revision,published_app_version_id,settings,principal_id,conversation_id,origin,task_prompt) values ($1,$2,$3,$4,'succeeded',1,$5,'{}',$6,$7,$8,$9)",
					work,
					tenant,
					integration,
					String(index),
					version,
					principal,
					conversation,
					origin,
					prompt,
				);
				await client.run(
					"insert into orchestration_events(id,tenant_id,integration_id,event_id,alarm_id,input,request_hash,work_item_id) values ($1,$2,$3,$4,$4,'old input',$5,$6)",
					event,
					tenant,
					integration,
					String(index),
					"c".repeat(64),
					work,
				);
				await client.run(
					"insert into orchestration_credentials values ($1,$2,$3,$4,'{}',now()+interval '1 hour')",
					credential,
					tenant,
					integration,
					work,
				);
				await client.run(
					"insert into orchestration_assignments(id,tenant_id,integration_id,work_item_id,event_id,credential_id,state,turn_id,report) values ($1,$2,$3,$4,$5,$6,'succeeded',$7,$8)",
					assignment,
					tenant,
					integration,
					work,
					event,
					credential,
					randomUUID(),
					`  historical ${index}\n`,
				);
			}
			const before = await client.run(
				"select w.id,w.state,w.published_app_version_id,a.report,e.request_hash from orchestration_work_items w join orchestration_assignments a on a.work_item_id=w.id join orchestration_events e on e.id=a.event_id order by w.alarm_id",
			);
			await copyFile(
				join(dir, "0027_orchestration_configuration_domain.sql"),
				join(older, "0027_orchestration_configuration_domain.sql"),
			);
			expect((await runMigrations(client, { migrationsDir: older })).applied).toEqual([
				"0027_orchestration_configuration_domain.sql",
			]);
			expect(
				await client.run(
					"select w.id,w.state,w.published_app_version_id,a.report,e.request_hash from orchestration_work_items w join orchestration_assignments a on a.work_item_id=w.id join orchestration_events e on e.id=a.event_id order by w.alarm_id",
				),
			).toEqual(before);
			expect(
				(await client.run("select request_contract from orchestration_work_items order by alarm_id")).map(
					(r) => r.request_contract,
				),
			).toEqual(["legacy_prompt", "legacy_input", "orchestration_event"]);
			expect(
				(await client.run("select request_hash_version from orchestration_events")).every(
					(r) => r.request_hash_version === 1,
				),
			).toBe(true);
			expect((await client.run("select count(*)::int as n from orchestration_versions"))[0]!.n).toBe(0);
			const before0028 = await client.run(
				"select w.*,a.report,e.request_hash from orchestration_work_items w join orchestration_assignments a on a.work_item_id=w.id join orchestration_events e on e.id=a.event_id order by w.alarm_id",
			);
			expect((await runMigrations(client)).applied).toEqual([
				"0028_aaas_business_context.sql",
				"0029_usage_view_aggregation.sql",
			]);
			const after0028 = await client.run(
				"select w.*,a.report,e.request_hash from orchestration_work_items w join orchestration_assignments a on a.work_item_id=w.id join orchestration_events e on e.id=a.event_id order by w.alarm_id",
			);
			expect(
				after0028.map(({ external_ref_id, external_ref_type, metadata, ...old }) => {
					expect([external_ref_id, external_ref_type, metadata]).toEqual([null, null, null]);
					return old;
				}),
			).toEqual(before0028);
			expect((await runMigrations(client)).applied).toEqual([]);
		} finally {
			await client.run(`drop schema ${schema} cascade`);
			await client.close();
			await rm(older, { recursive: true, force: true });
		}
	},
	30000,
);
