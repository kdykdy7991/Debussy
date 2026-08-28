import { createServer, type Server } from "node:http";
import type { ModelRef, SessionSnapshot, ThinkingLevel } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import { createAdminDebugSessionsHttpHandler } from "../../src/publishing/control/debug-sessions-http.ts";
import type { AgentDefinitionId, SkillId, TenantId } from "../../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";
import type { RuntimeSpec } from "../../src/publishing/runtime-spec/schema.ts";
import type {
	CreateSessionOptions,
	PiSessionBackend,
	PiSessionRuntime,
	PiSessionRuntimeEvent,
	PromptInput,
	SteerInput,
} from "../../src/types.ts";

const TENANT = "00000000-0000-7000-8000-000000000001" as TenantId;
const AGENT = "00000000-0000-7000-8000-000000000002" as AgentDefinitionId;
const SKILL = "00000000-0000-7000-8000-000000000003" as SkillId;
const TOKEN = "admin-test-token";

class FakeRuntime implements PiSessionRuntime {
	readonly ephemeral = true;
	disposed = false;
	readonly id: string;
	constructor(id: string) {
		this.id = id;
	}
	snapshot(): SessionSnapshot {
		return {
			id: this.id,
			cwd: "/tmp",
			createdAt: 1,
			updatedAt: 1,
			phase: "idle",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
			attached: false,
			locked: false,
			lastSequence: 0,
			revision: 0,
			transcript: [],
			queuedSteer: [],
			queuedSteerCount: 0,
		};
	}
	getPhase(): "idle" {
		return "idle";
	}
	async prompt(_input: PromptInput): Promise<void> {}
	async steer(_input: SteerInput): Promise<void> {}
	async abort(): Promise<void> {}
	async setModel(_model: ModelRef): Promise<void> {}
	async setThinking(_thinkingLevel: ThinkingLevel): Promise<void> {}
	subscribe(_listener: (event: PiSessionRuntimeEvent) => void): () => void {
		return () => {};
	}
	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

describe("admin debug sessions HTTP", () => {
	let server: Server | undefined;
	let closeHandler: (() => Promise<void>) | undefined;
	afterEach(async () => {
		if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
		await closeHandler?.();
	});

	test("creates a revision-bound ephemeral session with materialized Skills", async () => {
		let createdOptions: CreateSessionOptions | undefined;
		let materialized: RuntimeSpec["capabilities"]["skills"] | undefined;
		const audits: string[] = [];
		const runtimeById = new Map<string, FakeRuntime>();
		const backend: PiSessionBackend = {
			async listSessions() {
				return [];
			},
			async listModels() {
				return [];
			},
			async createSession(options) {
				createdOptions = options;
				const runtime = new FakeRuntime(options.id);
				runtimeById.set(options.id, runtime);
				return runtime;
			},
			async openSession(id) {
				const runtime = runtimeById.get(id);
				if (runtime === undefined) throw new Error("missing");
				return runtime;
			},
		};
		const repositories = {
			agentDefinitions: {
				getRevision: async () => ({
					agentDefinitionId: AGENT,
					tenantId: TENANT,
					name: "测试001agent",
					revision: 2,
					draftConfig: { prompt: "Agent prompt", model: { provider: "faux", modelId: "faux-1" } },
					sourceHash: "a".repeat(64),
					createdAt: new Date(),
					updatedAt: new Date(),
				}),
			},
			skills: {
				listBindings: async () => [
					{
						tenantId: TENANT,
						agentDefinitionId: AGENT,
						agentRevision: 2,
						position: 0,
						skillId: SKILL,
						skillRevision: 1,
					},
				],
				getRevision: async () => ({
					skillId: SKILL,
					tenantId: TENANT,
					revision: 1,
					artifactId: "00000000-0000-7000-8000-000000000004",
					sourceHash: "b".repeat(64),
					parsedName: "analyze",
					description: "Analyze data",
					instructionText: "# Analyze",
					disableModelInvocation: false,
					diagnostics: [],
					createdAt: new Date(),
				}),
			},
			audit: {
				insert: async (record: { action: string }) => {
					audits.push(record.action);
				},
			},
		} as unknown as PublishingRepositories;
		const debug = createAdminDebugSessionsHttpHandler({
			backend,
			repositories,
			tenantId: TENANT,
			isAuthorized: (request) => request.headers.authorization === `Bearer ${TOKEN}`,
			skillMaterializer: {
				async materialize() {
					return [];
				},
				async materializeSkills(_runtimeId, skills) {
					materialized = skills;
					return [
						{
							name: "analyze",
							description: "Analyze data",
							filePath: "/runtime/analyze/SKILL.md",
							baseDir: "/runtime/analyze",
							disableModelInvocation: false,
						},
					];
				},
			},
		});
		closeHandler = debug.close;
		server = createServer((request, response) => void debug.handler(request, response));
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("missing address");
		const response = await fetch(`http://127.0.0.1:${address.port}/api/control/v1/debug-sessions`, {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ agentId: `agent_${AGENT}`, revision: 2 }),
		});
		expect(response.status).toBe(201);
		const envelope = (await response.json()) as { data: { sessionId: string } };
		expect(createdOptions).toMatchObject({
			ephemeral: true,
			model: { provider: "faux", id: "faux-1" },
			resourceOverrides: { systemPrompt: "Agent prompt", skills: [{ name: "analyze" }] },
		});
		expect(materialized?.map((skill) => skill.name)).toEqual(["analyze"]);
		expect(audits).toContain("debug-session.created");
		const deleted = await fetch(
			`http://127.0.0.1:${address.port}/api/control/v1/debug-sessions/${envelope.data.sessionId}`,
			{ method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } },
		);
		expect(deleted.status).toBe(200);
		expect(runtimeById.get(envelope.data.sessionId)?.disposed).toBe(true);
	});
});
