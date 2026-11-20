/**
 * DB-level acceptance for Prompt Cache usage aggregation.
 *
 * The unit tests stub repository rows; this test runs the real SQL against an
 * isolated PostgreSQL schema so the JSONB cache extraction, the weighted hit
 * rate and the "unknown vs zero" coverage counts are proven end to end.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { runMigrations } from "../../src/persistence/postgres/migrate.ts";
import { createConversationEventRepository } from "../../src/persistence/postgres/repositories/conversation-events.ts";
import type { TenantId } from "../../src/publishing/domain/ids.ts";

const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";
const SCHEMA = `aaas_cache_usage_${process.pid}_${Date.now().toString(36)}`;

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

describe.skipIf(!pgUp)("Prompt Cache usage aggregation on isolated Postgres", () => {
	const tenantId = randomUUID() as TenantId;
	let client: PostgresClient;
	let repository: ReturnType<typeof createConversationEventRepository>;

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		repository = createConversationEventRepository(client);

		const agentId = randomUUID();
		const appId = randomUUID();
		const versionId = randomUUID();
		const principalId = randomUUID();
		await client.run("insert into tenants(id,name,status) values ($1,'cache-usage','active')", tenantId);
		await client.run(
			"insert into agent_definitions(id,tenant_id,name,revision,draft_config,created_by) values ($1,$2,'agent',1,'{}'::jsonb,$1)",
			agentId,
			tenantId,
		);
		await client.run(
			`insert into published_apps(id,tenant_id,agent_definition_id,public_app_id,name,status,access_mode,created_by)
			 values ($1,$2,$3,'pub_cache','Cache App','active','anonymous',$1)`,
			appId,
			tenantId,
			agentId,
		);
		await client.run(
			`insert into published_app_versions
			 (id,tenant_id,published_app_id,version_number,source_agent_revision,snapshot,runtime_spec,runtime_spec_hash,status,created_by)
			 values ($1,$2,$3,1,1,'{}'::jsonb,'{}'::jsonb,$4,'ready',$1)`,
			versionId,
			tenantId,
			appId,
			"a".repeat(64),
		);
		await client.run(
			`insert into principals(id,tenant_id,published_app_id,principal_type,subject_hash,status)
			 values ($1,$2,$3,'external_user',$4,'active')`,
			principalId,
			tenantId,
			appId,
			"b".repeat(64),
		);

		const integrationId = randomUUID();
		await client.run(
			`insert into orchestration_integrations
			 (id,tenant_id,published_app_id,published_app_version_id,name,secret_hash,settings)
			 values ($1,$2,$3,$4,'legacy integration','hash','{}'::jsonb)`,
			integrationId,
			tenantId,
			appId,
			versionId,
		);

		// Orchestration Run with a complete provider usage that reported cache data.
		const orchestrationConversationId = randomUUID();
		await client.run(
			`insert into conversations(id,tenant_id,published_app_id,published_app_version_id,owner_principal_id,status)
			 values ($1,$2,$3,$4,$5,'active')`,
			orchestrationConversationId,
			tenantId,
			appId,
			versionId,
			principalId,
		);
		const workItemId = randomUUID();
		await client.run(
			`insert into orchestration_work_items
			 (id,tenant_id,integration_id,alarm_id,state,configuration_revision,published_app_version_id,settings,principal_id,conversation_id,request_contract)
			 values ($1,$2,$3,'cache-run','succeeded',1,$4,'{}'::jsonb,$5,$6,'legacy_prompt')`,
			workItemId,
			tenantId,
			integrationId,
			versionId,
			principalId,
			orchestrationConversationId,
		);
		await client.run(
			`insert into conversation_events(id,tenant_id,published_app_id,conversation_id,sequence,event_type,turn_id,payload)
			 values ($1,$2,$3,$4,1,'turn/start',null,'{}'::jsonb)`,
			randomUUID(),
			tenantId,
			appId,
			orchestrationConversationId,
		);
		await client.run(
			`insert into conversation_events(id,tenant_id,published_app_id,conversation_id,sequence,event_type,turn_id,payload)
			 values ($1,$2,$3,$4,2,'turn/end',null,$5::jsonb)`,
			randomUUID(),
			tenantId,
			appId,
			orchestrationConversationId,
			{
				llmUsage: {
					calls: [
						{
							model: "Qwen",
							input: 400,
							output: 100,
							cacheRead: 100,
							cacheWrite: 0,
							totalTokens: 600,
							cacheReadReported: true,
						},
					],
					total: {
						input: 400,
						output: 100,
						cacheRead: 100,
						cacheWrite: 0,
						totalTokens: 600,
						cacheReadReported: true,
						cacheReadReportedCallCount: 1,
					},
					callCount: 1,
					partial: false,
				},
			},
		);

		// A second complete Run whose provider omitted the cache fields entirely.
		const unknownConversationId = randomUUID();
		await client.run(
			`insert into conversations(id,tenant_id,published_app_id,published_app_version_id,owner_principal_id,status)
			 values ($1,$2,$3,$4,$5,'active')`,
			unknownConversationId,
			tenantId,
			appId,
			versionId,
			principalId,
		);
		await client.run(
			`insert into orchestration_work_items
			 (id,tenant_id,integration_id,alarm_id,state,configuration_revision,published_app_version_id,settings,principal_id,conversation_id,request_contract)
			 values ($1,$2,$3,'cache-unknown','succeeded',1,$4,'{}'::jsonb,$5,$6,'legacy_prompt')`,
			randomUUID(),
			tenantId,
			integrationId,
			versionId,
			principalId,
			unknownConversationId,
		);
		await client.run(
			`insert into conversation_events(id,tenant_id,published_app_id,conversation_id,sequence,event_type,turn_id,payload)
			 values ($1,$2,$3,$4,2,'turn/end',null,$5::jsonb)`,
			randomUUID(),
			tenantId,
			appId,
			unknownConversationId,
			{
				llmUsage: {
					calls: [{ model: "Qwen", input: 700, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 800 }],
					total: {
						input: 700,
						output: 100,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 800,
						cacheReadReported: false,
						cacheReadReportedCallCount: 0,
					},
					callCount: 1,
					partial: false,
				},
			},
		);

		// A Chat-only turn with reported cache data (zero misses excluded from nothing).
		const chatConversationId = randomUUID();
		await client.run(
			`insert into conversations(id,tenant_id,published_app_id,published_app_version_id,owner_principal_id,status)
			 values ($1,$2,$3,$4,$5,'active')`,
			chatConversationId,
			tenantId,
			appId,
			versionId,
			principalId,
		);
		await client.run(
			`insert into conversation_events(id,tenant_id,published_app_id,conversation_id,sequence,event_type,turn_id,payload)
			 values ($1,$2,$3,$4,2,'turn/end',$5,$6::jsonb)`,
			randomUUID(),
			tenantId,
			appId,
			chatConversationId,
			randomUUID(),
			{
				llmUsage: {
					calls: [
						{
							model: "Qwen",
							input: 50,
							output: 10,
							cacheRead: 150,
							cacheWrite: 0,
							totalTokens: 210,
							// Historical response kept the positive count without the marker.
						},
					],
					total: {
						input: 50,
						output: 10,
						cacheRead: 150,
						cacheWrite: 0,
						totalTokens: 210,
						cacheReadReported: true,
						cacheReadReportedCallCount: 1,
					},
					callCount: 1,
					partial: false,
				},
			},
		);

		// A Run whose calls only partially reported the cache read: two of the
		// three calls reported it, the third one did not. The reported calls must
		// still contribute their hits and prompt tokens.
		const mixedConversationId = randomUUID();
		await client.run(
			`insert into conversations(id,tenant_id,published_app_id,published_app_version_id,owner_principal_id,status)
			 values ($1,$2,$3,$4,$5,'active')`,
			mixedConversationId,
			tenantId,
			appId,
			versionId,
			principalId,
		);
		await client.run(
			`insert into orchestration_work_items
			 (id,tenant_id,integration_id,alarm_id,state,configuration_revision,published_app_version_id,settings,principal_id,conversation_id,request_contract)
			 values ($1,$2,$3,'cache-mixed','succeeded',1,$4,'{}'::jsonb,$5,$6,'legacy_prompt')`,
			randomUUID(),
			tenantId,
			integrationId,
			versionId,
			principalId,
			mixedConversationId,
		);
		await client.run(
			`insert into conversation_events(id,tenant_id,published_app_id,conversation_id,sequence,event_type,turn_id,payload)
			 values ($1,$2,$3,$4,2,'turn/end',null,$5::jsonb)`,
			randomUUID(),
			tenantId,
			appId,
			mixedConversationId,
			{
				llmUsage: {
					calls: [
						{
							model: "Qwen",
							input: 100,
							output: 10,
							cacheRead: 300,
							cacheWrite: 0,
							totalTokens: 410,
							cacheReadReported: true,
						},
						{
							model: "Qwen",
							input: 200,
							output: 20,
							cacheRead: 100,
							cacheWrite: 50,
							totalTokens: 370,
							cacheReadReported: true,
						},
						{
							// No cacheReadReported flag: unknown cache data, not a miss.
							model: "Qwen",
							input: 500,
							output: 30,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 530,
						},
					],
					total: {
						input: 800,
						output: 60,
						cacheRead: 400,
						cacheWrite: 50,
						totalTokens: 1310,
						// The row-level flag is false because not every call reported.
						cacheReadReported: false,
						cacheReadReportedCallCount: 2,
					},
					callCount: 3,
					partial: false,
				},
			},
		);

		// A Chat turn with the same mixed shape: two reported calls, one without.
		const mixedChatConversationId = randomUUID();
		await client.run(
			`insert into conversations(id,tenant_id,published_app_id,published_app_version_id,owner_principal_id,status)
			 values ($1,$2,$3,$4,$5,'active')`,
			mixedChatConversationId,
			tenantId,
			appId,
			versionId,
			principalId,
		);
		await client.run(
			`insert into conversation_events(id,tenant_id,published_app_id,conversation_id,sequence,event_type,turn_id,payload)
			 values ($1,$2,$3,$4,2,'turn/end',$5,$6::jsonb)`,
			randomUUID(),
			tenantId,
			appId,
			mixedChatConversationId,
			randomUUID(),
			{
				llmUsage: {
					calls: [
						{
							model: "Qwen",
							input: 40,
							output: 5,
							cacheRead: 60,
							cacheWrite: 0,
							totalTokens: 105,
							// Historical response kept the positive count without the marker.
						},
						{
							model: "Qwen",
							input: 60,
							output: 5,
							cacheRead: 20,
							cacheWrite: 0,
							totalTokens: 85,
							cacheReadReported: true,
						},
						{
							model: "Qwen",
							input: 300,
							output: 5,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 305,
						},
					],
					total: {
						input: 400,
						output: 15,
						cacheRead: 80,
						cacheWrite: 0,
						totalTokens: 495,
						cacheReadReported: false,
						cacheReadReportedCallCount: 2,
					},
					callCount: 3,
					partial: false,
				},
			},
		);
	});

	afterAll(async () => {
		if (!client) return;
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.close();
	});

	test("orchestration view reports cached/miss/rate and unknown coverage", async () => {
		const usage = await repository.summarizeOrchestrationUsage!({
			scope: { tenantId },
			from: new Date("2026-01-01T00:00:00.000Z"),
			to: new Date("2027-01-01T00:00:00.000Z"),
		});
		const view = usage.view;
		expect(view).toBeDefined();
		const reported = view?.runs.find((row) => row.accurateTokens === 600);
		expect(reported).toMatchObject({
			tokenCoverage: "complete",
			cacheHitTokens: 100,
			cacheMissTokens: 400,
			cachePromptTokens: 500,
			cacheHitRate: 0.2,
		});
		const unknown = view?.runs.find((row) => row.accurateTokens === 800);
		expect(unknown).toMatchObject({
			tokenCoverage: "complete",
			cacheHitTokens: null,
			cacheMissTokens: null,
			cachePromptTokens: null,
			cacheHitRate: null,
		});
		expect(view?.coverage).toMatchObject({
			// Coverage spans every complete Run of the period: the reported Run,
			// the Run whose provider omitted the cache fields, and the Run whose
			// calls only partially reported (see the next test).
			cacheReportedRuns: 2,
			cacheUnknownRuns: 1,
			cacheHitTokens: 500,
			cachePromptTokens: 1250,
			cacheMissTokens: 750,
			cacheHitRate: 0.4,
		});
	});

	test("orchestration view keeps the reported calls of a partially reporting run", async () => {
		const usage = await repository.summarizeOrchestrationUsage!({
			scope: { tenantId },
			from: new Date("2026-01-01T00:00:00.000Z"),
			to: new Date("2027-01-01T00:00:00.000Z"),
		});
		const view = usage.view;
		// Two of three calls reported the cache read: their hits and prompt
		// tokens are included, the unreported call is excluded from both.
		const mixed = view?.runs.find((row) => row.accurateTokens === 1310);
		expect(mixed).toMatchObject({
			tokenCoverage: "complete",
			cacheHitTokens: 400,
			cacheMissTokens: 350,
			cachePromptTokens: 750,
			cacheHitRate: 400 / 750,
			cacheReportedCalls: 2,
			cacheUnknownCalls: 1,
		});
		expect(view?.coverage).toMatchObject({
			cacheReportedRuns: 2,
			cacheUnknownRuns: 1,
			cacheReportedCalls: 3,
			cacheUnknownCalls: 2,
			cacheHitTokens: 500,
			cachePromptTokens: 1250,
			cacheMissTokens: 750,
			cacheHitRate: 0.4,
		});
	});

	test("chat view keeps cache data and unknown rows separate", async () => {
		const view = await repository.summarizeChatUsageView!({
			scope: { tenantId },
			from: new Date("2026-01-01T00:00:00.000Z"),
			to: new Date("2027-01-01T00:00:00.000Z"),
		});
		expect(view.runs).toHaveLength(2);
		expect(view.runs.find((row) => row.accurateTokens === 210)).toMatchObject({
			cacheHitTokens: 150,
			cacheMissTokens: 50,
			cachePromptTokens: 200,
			cacheHitRate: 0.75,
		});
		expect(view.coverage).toMatchObject({
			cacheReportedRuns: 2,
			cacheUnknownRuns: 0,
			cacheHitTokens: 230,
			cachePromptTokens: 380,
			cacheMissTokens: 150,
			cacheHitRate: 230 / 380,
		});
	});

	test("chat view keeps the reported calls of a partially reporting turn", async () => {
		const view = await repository.summarizeChatUsageView!({
			scope: { tenantId },
			from: new Date("2026-01-01T00:00:00.000Z"),
			to: new Date("2027-01-01T00:00:00.000Z"),
		});
		const mixed = view.runs.find((row) => row.accurateTokens === 495);
		expect(mixed).toMatchObject({
			tokenCoverage: "complete",
			cacheHitTokens: 80,
			cacheMissTokens: 100,
			cachePromptTokens: 180,
			cacheHitRate: 80 / 180,
			cacheReportedCalls: 2,
			cacheUnknownCalls: 1,
		});
		expect(view.coverage).toMatchObject({
			cacheReportedRuns: 2,
			cacheUnknownRuns: 0,
			cacheReportedCalls: 3,
			cacheUnknownCalls: 1,
			cacheHitTokens: 230,
			cachePromptTokens: 380,
			cacheMissTokens: 150,
			cacheHitRate: 230 / 380,
		});
	});
});
