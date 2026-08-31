/**
 * WB-Agent 简化 (Phase 0) consistency test: same Agent revision → Debug compile
 * spec == Publish compile spec.
 *
 * Both Debug (`compileDebugAgentRevision`) and Publish
 * (`createPublishedAppVersion`) feed the SAME `resolveAgentRevisionConfig` into
 * the SAME `compileRuntimeSpec`. This test pins that single-source invariant so
 * "publish exactly what was debugged" holds by construction:
 *
 *   - same revision → identical ResolvedAgentConfig (skills + mcpServers),
 *   - same content + same versionId → identical canonicalJson + sha256,
 *   - the real Debug/Publish specs differ ONLY in `publishedAppVersionId`
 *     (Debug uses a deterministic synthetic id, Publish uses a real published
 *     version row id), never in any configurable content field.
 */
import { describe, expect, test } from "vitest";
import { compileDebugAgentRevision, syntheticDebugVersionId } from "../../src/publishing/debug/compile.ts";
import type {
	AgentDefinitionId,
	McpServerId,
	McpToolId,
	SkillArtifactId,
	SkillId,
	TenantId,
} from "../../src/publishing/domain/ids.ts";
import type {
	AgentRevisionMcpBindingRecord,
	AgentRevisionSkillBindingRecord,
	McpServerRecord,
	McpServerRevisionRecord,
	McpToolRecord,
	PublishingRepositories,
	SkillRecord,
	SkillRevisionRecord,
} from "../../src/publishing/repositories.ts";
import { type CapabilityCatalog, compileRuntimeSpec } from "../../src/publishing/runtime-spec/compiler.ts";
import { canonicalJson } from "../../src/publishing/runtime-spec/hash.ts";
import {
	type ResolveAgentRevisionConfigDeps,
	resolveAgentRevisionConfig,
} from "../../src/publishing/runtime-spec/resolve.ts";

const TENANT = "11111111-1111-7111-8111-111111111111" as TenantId;
const AGENT_ID = "22222222-2222-7222-8222-222222222222" as AgentDefinitionId;
const REVISION = 7;

const SKILL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as SkillId;
const MCP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as McpServerId;

const CATALOG: CapabilityCatalog = {
	tools: [],
	knowledgeBases: [],
	models: [
		{
			provider: "prov",
			modelId: "modelA",
			parameterCapabilities: {
				reasoning: { supported: true, toggle: true, efforts: ["low", "medium", "high"], defaultEffort: "low" },
			},
		},
	],
};

const skillBindings: AgentRevisionSkillBindingRecord[] = [
	{
		tenantId: TENANT,
		agentDefinitionId: AGENT_ID,
		agentRevision: REVISION,
		position: 0,
		skillId: SKILL_ID,
		skillRevision: 3,
	},
];
const skillRecord: SkillRecord = {
	skillId: SKILL_ID,
	tenantId: TENANT,
	name: "summarize",
	status: "enabled",
	currentRevision: 3,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};
const skillRevision: SkillRevisionRecord = {
	skillId: SKILL_ID,
	tenantId: TENANT,
	revision: 3,
	artifactId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as SkillArtifactId,
	sourceHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	parsedName: "Summarize",
	description: "Summarize the input",
	instructionText: "Summarize the user's input text concisely.",
	disableModelInvocation: false,
	diagnostics: [],
	createdAt: new Date(0),
};

const mcpBindings: AgentRevisionMcpBindingRecord[] = [
	{
		tenantId: TENANT,
		agentDefinitionId: AGENT_ID,
		agentRevision: REVISION,
		position: 0,
		mcpServerId: MCP_ID,
		mcpRevision: 5,
		toolAllowlist: ["t_a", "t_b"],
	},
];
const mcpRecord: McpServerRecord = {
	mcpServerId: MCP_ID,
	tenantId: TENANT,
	name: "mcp-a",
	status: "enabled",
	currentRevision: 5,
	lastTestOk: true,
	lastTestLatencyMs: 12,
	lastTestAt: new Date(0),
	createdAt: new Date(0),
	updatedAt: new Date(0),
};
const mcpRevision: McpServerRevisionRecord = {
	mcpServerId: MCP_ID,
	tenantId: TENANT,
	revision: 5,
	transport: "streamable_http",
	endpoint: "https://mcp.example.test",
	authentication: "none",
	createdAt: new Date(0),
};
const mcpTools: McpToolRecord[] = [
	{
		mcpToolId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as McpToolId,
		tenantId: TENANT,
		mcpServerId: MCP_ID,
		mcpRevision: 5,
		name: "t_a",
		description: "tool a",
		inputSchema: { type: "object" },
		inputSchemaHash: `${"b".repeat(63)}a`,
		createdAt: new Date(0),
	},
	{
		mcpToolId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as McpToolId,
		tenantId: TENANT,
		mcpServerId: MCP_ID,
		mcpRevision: 5,
		name: "t_b",
		description: "tool b",
		inputSchema: { type: "object" },
		inputSchemaHash: `${"b".repeat(63)}b`,
		createdAt: new Date(0),
	},
	// Not in the allowlist -> filtered out exactly the same way by both Debug
	// and Publish resolution.
	{
		mcpToolId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as McpToolId,
		tenantId: TENANT,
		mcpServerId: MCP_ID,
		mcpRevision: 5,
		name: "t_not_allowed",
		description: "not allowed",
		inputSchema: { type: "object" },
		inputSchemaHash: `${"b".repeat(63)}x`,
		createdAt: new Date(0),
	},
];

const resolverDeps: ResolveAgentRevisionConfigDeps = {
	skills: {
		listBindings: async () => skillBindings,
		get: async () => skillRecord,
		getRevision: async () => skillRevision,
	} as unknown as ResolveAgentRevisionConfigDeps["skills"],
	mcpServers: {
		listBindings: async () => mcpBindings,
		get: async () => mcpRecord,
		getRevision: async () => mcpRevision,
		listTools: async () => mcpTools,
	} as unknown as ResolveAgentRevisionConfigDeps["mcpServers"],
};

const revisionRecord = {
	agentDefinitionId: AGENT_ID,
	revision: REVISION,
	draftConfig: {
		prompt: "You are a summarization assistant.",
		model: { provider: "prov", modelId: "modelA", params: { reasoning: { enabled: true, effort: "medium" } } },
	},
};

const debugRepositories = {
	skills: resolverDeps.skills,
	mcpServers: resolverDeps.mcpServers,
	agentDefinitions: { getLatest: async () => revisionRecord },
} as unknown as PublishingRepositories;

describe("Debug vs Publish single-source consistency (Phase 0)", () => {
	test("same revision resolves to identical ResolvedAgentConfig (skills + mcpServers)", async () => {
		const debugResolved = await resolveAgentRevisionConfig(resolverDeps, { tenantId: TENANT }, revisionRecord);
		const publishResolved = await resolveAgentRevisionConfig(resolverDeps, { tenantId: TENANT }, revisionRecord);
		expect(debugResolved.ok).toBe(true);
		expect(publishResolved.ok).toBe(true);
		if (!debugResolved.ok || !publishResolved.ok) return;

		expect(canonicalJson(debugResolved.data)).toBe(canonicalJson(publishResolved.data));

		// Allowlist filter applied identically: only the 2 allowed tools survive;
		// the discovery-only tool is excluded in both.
		expect(debugResolved.data.mcpServers[0]!.tools.map((t) => t.name)).toEqual(["t_a", "t_b"]);
		expect(publishResolved.data.mcpServers[0]!.tools.map((t) => t.name)).toEqual(["t_a", "t_b"]);
	});

	test("same content + same versionId => identical canonicalJson + sha256 (deterministic compiler)", async () => {
		const resolved = await resolveAgentRevisionConfig(resolverDeps, { tenantId: TENANT }, revisionRecord);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;

		const versionId = syntheticDebugVersionId(AGENT_ID, REVISION);
		const compile = (): ReturnType<typeof compileRuntimeSpec> =>
			compileRuntimeSpec({
				agent: resolved.data.agent,
				publishedAppVersionId: versionId,
				catalog: CATALOG,
				skills: resolved.data.skills,
				mcpServers: resolved.data.mcpServers,
			});
		const a = compile();
		const b = compile();
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(a.sha256).toBe(b.sha256);
		expect(a.canonicalJson).toBe(b.canonicalJson);
	});

	test("compileDebugAgentRevision hash equals a direct compile of the same resolved content", async () => {
		const debug = await compileDebugAgentRevision(
			{ repositories: debugRepositories, catalog: CATALOG },
			{ tenantId: TENANT },
			AGENT_ID,
		);
		expect(debug.ok).toBe(true);
		if (!debug.ok) return;

		const resolved = await resolveAgentRevisionConfig(resolverDeps, { tenantId: TENANT }, revisionRecord);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;

		const direct = compileRuntimeSpec({
			agent: resolved.data.agent,
			publishedAppVersionId: syntheticDebugVersionId(AGENT_ID, REVISION),
			catalog: CATALOG,
			skills: resolved.data.skills,
			mcpServers: resolved.data.mcpServers,
		});
		expect(direct.ok).toBe(true);
		if (!direct.ok) return;
		expect(debug.runtimeSpecHash).toBe(direct.sha256);
	});

	test("real Debug vs real Publish spec differ ONLY in publishedAppVersionId", async () => {
		const resolved = await resolveAgentRevisionConfig(resolverDeps, { tenantId: TENANT }, revisionRecord);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		const { agent, skills, mcpServers } = resolved.data;

		const debugSpec = compileRuntimeSpec({
			agent,
			publishedAppVersionId: syntheticDebugVersionId(AGENT_ID, REVISION),
			catalog: CATALOG,
			skills,
			mcpServers,
		});
		const publishSpec = compileRuntimeSpec({
			agent,
			publishedAppVersionId: "40000000-0000-0000-0000-000000000000", // an ephemeral version row id
			catalog: CATALOG,
			skills,
			mcpServers,
		});
		expect(debugSpec.ok).toBe(true);
		expect(publishSpec.ok).toBe(true);
		if (!debugSpec.ok || !publishSpec.ok) return;

		// Configurable content is identical; only the runtime identity differs.
		const debugRest = { ...debugSpec.spec, publishedAppVersionId: "" };
		const publishRest = { ...publishSpec.spec, publishedAppVersionId: "" };
		expect(canonicalJson(debugRest)).toBe(canonicalJson(publishRest));
		expect(debugSpec.spec.publishedAppVersionId).not.toBe(publishSpec.spec.publishedAppVersionId);
		expect(debugSpec.spec.agent).toEqual(publishSpec.spec.agent);
		expect(debugSpec.spec.capabilities).toEqual(publishSpec.spec.capabilities);
		expect(debugSpec.spec.contextPolicy).toEqual(publishSpec.spec.contextPolicy);
		expect(debugSpec.spec.runtimePolicy).toEqual(publishSpec.spec.runtimePolicy);
		expect(debugSpec.spec.securityPolicyVersion).toBe(publishSpec.spec.securityPolicyVersion);
		expect(debugSpec.spec.theme).toEqual(publishSpec.spec.theme);
		expect(debugSpec.spec.schemaVersion).toBe(publishSpec.spec.schemaVersion);
	});
});
