import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	type AgentSessionServices,
	createExtensionRuntime,
	ModelRuntime,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
	CommandResult,
	ResponseEnvelope,
	SessionSnapshot,
	SessionSummary,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test } from "vitest";
import { CodingAgentPiSessionBackend } from "../src/coding-agent/index.ts";
import type { PiServer } from "../src/index.ts";
import { connectWebSocketTestClient, type ProtocolTestClient } from "../src/testing/index.ts";
import { createWebSocketServer } from "../src/transports/websocket/index.ts";

/**
 * B6 end-to-end tests for the Coding Agent backend adapter.
 *
 * Every test drives a real `CodingAgentPiSessionBackend` (and, in the WebSocket
 * section, a real `PiServer` listener) backed by the pi-ai faux provider, so no
 * real model API is ever contacted. The faux provider scripts responses and can
 * slow the stream down (`tokensPerSecond`) to leave a window for abort/steer.
 */

const tempDirs: string[] = [];
const servers = new Set<PiServer>();
const clients = new Set<ProtocolTestClient>();

/** Inert resource loader: no extensions, skills, prompts, or themes on disk. */
function makeResourceLoader() {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

/** Build a fresh backend + faux provider over a throwaway temp tree. */
async function makeHarness(fauxOptions: { tokensPerSecond?: number } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-b6-"));
	tempDirs.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(cwd, "notes.txt"), "alpha beta gamma\n");

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		provider: "faux",
		models: [
			{ id: "faux-1", name: "Faux One", reasoning: true },
			{ id: "faux-2", name: "Faux Two", reasoning: true },
		],
		...(fauxOptions.tokensPerSecond !== undefined ? { tokensPerSecond: fauxOptions.tokensPerSecond } : {}),
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });

	const settingsManager = SettingsManager.create(cwd, agentDir);
	const services: AgentSessionServices = {
		cwd,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader: makeResourceLoader() as AgentSessionServices["resourceLoader"],
		diagnostics: [],
	};
	const backend = await CodingAgentPiSessionBackend.create({
		cwd,
		agentDir,
		sessionDir: join(root, "sessions"),
		services,
	});
	return { backend, faux, root };
}

async function startWireServer(backend: CodingAgentPiSessionBackend): Promise<string> {
	const server = createWebSocketServer(backend, { port: 0 });
	servers.add(server);
	await server.start();
	const address = server.addresses[0]!;
	const port = Number(address.slice(address.lastIndexOf(":") + 1));
	return `ws://127.0.0.1:${port}/api/pi/v1/ws`;
}

async function connect(url: string): Promise<ProtocolTestClient> {
	const client = await connectWebSocketTestClient(url);
	clients.add(client);
	return client;
}

/** Narrow a command result union down to its `session` payload (wire command result). */
function sessionOf(result: CommandResult): SessionSnapshot {
	return (result as unknown as { session: SessionSnapshot }).session;
}

function sessionsOf(result: CommandResult): readonly SessionSummary[] {
	return (result as unknown as { sessions: readonly SessionSummary[] }).sessions;
}

afterEach(async () => {
	await Promise.all([...clients].map((client) => client.close()));
	clients.clear();
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
	for (const dir of tempDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
	tempDirs.length = 0;
});

// ============================================================================
// Backend-level tests (direct CodingAgentPiSessionBackend / runtime calls)
// ============================================================================

describe("CodingAgentPiSessionBackend", () => {
	test("disableLocalSkills prevents main-chat discovery of machine Skills", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-b6-no-local-skills-"));
		tempDirs.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const localSkillDir = join(agentDir, "skills", "host-only");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(localSkillDir, { recursive: true });
		writeFileSync(join(localSkillDir, "SKILL.md"), "---\nname: host-only\ndescription: Host only.\n---\n# Host");

		const backend = await CodingAgentPiSessionBackend.create({
			cwd,
			agentDir,
			sessionDir: join(root, "sessions"),
			disableLocalSkills: true,
		});

		expect(backend.getServices().resourceLoader.getSkills().skills).toEqual([]);
	});

	test("listSessions empty, listModels has faux model", async () => {
		const { backend } = await makeHarness();
		expect(await backend.listSessions()).toEqual([]);
		const models = await backend.listModels();
		const fauxModels = models.filter((m) => m.provider === "faux");
		expect(fauxModels.map((m) => m.id).sort()).toEqual(["faux-1", "faux-2"]);
	});

	test("ephemeral sessions are not written to the session index", async () => {
		const { backend } = await makeHarness();
		const runtime = await backend.createSession({
			id: "debug-ephemeral",
			model: { provider: "faux", id: "faux-1" },
			ephemeral: true,
		});

		expect((await backend.listSessions()).map((session) => session.id)).not.toContain("debug-ephemeral");
		await runtime.dispose();
		await expect(backend.openSession("debug-ephemeral")).rejects.toThrow(/Unknown session/);
	});

	test("createSession with resourceOverrides builds an isolated per-session loader", async () => {
		const { backend, root } = await makeHarness();
		// A real host/user Skill must not leak into the published session.
		const hostOnlyDir = join(root, "agent", "skills", "host-only");
		mkdirSync(hostOnlyDir, { recursive: true });
		writeFileSync(join(hostOnlyDir, "SKILL.md"), "---\nname: host-only\ndescription: Host only.\n---\n# Host only");
		// A published version binds one available skill and one model-hidden skill.
		const analyzeDir = join(root, "runtime-skills", "pav_x", "analyze");
		const archiveDir = join(root, "runtime-skills", "pav_x", "archive");
		mkdirSync(analyzeDir, { recursive: true });
		mkdirSync(archiveDir, { recursive: true });
		writeFileSync(join(analyzeDir, "SKILL.md"), "# Analyze\nUse this skill body.");
		writeFileSync(join(archiveDir, "SKILL.md"), "# Archive\nExplicit only.");
		const overrides = {
			systemPrompt: "FROZEN published prompt for pav_x.",
			skills: [
				{
					name: "analyze",
					description: "Answer data questions.",
					filePath: join(analyzeDir, "SKILL.md"),
					baseDir: analyzeDir,
					disableModelInvocation: false,
				},
				{
					name: "archive",
					description: "Explicit only.",
					filePath: join(archiveDir, "SKILL.md"),
					baseDir: archiveDir,
					disableModelInvocation: true,
				},
			],
		};

		const runtime = await backend.createSession({
			id: "published-sess",
			model: { provider: "faux", id: "faux-1" },
			resourceOverrides: overrides,
		});

		const session = (runtime as unknown as { session: unknown }).session as {
			systemPrompt: string;
			resourceLoader: { getSkills(): { skills: Array<{ name: string; disableModelInvocation: boolean }> } };
		};
		// The frozen prompt is what the session carries (via its per-session loader).
		expect(session.systemPrompt).toContain("FROZEN published prompt for pav_x.");
		// A bound Skill is disclosed to the model through the prompt's
		// <available_skills> block (progressive disclosure). `archive` is
		// model-hidden (disableModelInvocation), so only `analyze` is visible.
		expect(session.systemPrompt).toContain("<available_skills>");
		expect(session.systemPrompt).toContain("analyze");
		const skills = session.resourceLoader.getSkills().skills;
		// Only the published version's bound skills are visible — no host/project skills.
		expect(skills.map((s) => s.name).sort()).toEqual(["analyze", "archive"]);
		const analyze = skills.find((s) => s.name === "analyze")!;
		expect(analyze.disableModelInvocation).toBe(false);
		const archive = skills.find((s) => s.name === "archive")!;
		expect(archive.disableModelInvocation).toBe(true);

		// Published sessions preserve Pi's native read capability. Filesystem
		// isolation is a future sandbox responsibility, not a tool allowlist.
		const readTool = (session as unknown as { _toolRegistry: Map<string, unknown> })._toolRegistry.get("read") as {
			execute(id: string, args: { path: string }): Promise<{ content: Array<{ type: "text"; text: string }> }>;
		};
		const allowed = await readTool.execute("read-ok", { path: join(analyzeDir, "SKILL.md") });
		expect(allowed.content[0]?.text).toContain("Use this skill body.");
		writeFileSync(join(root, "notes.txt"), "published session can read this.");
		const regularRead = await readTool.execute("read-regular", { path: join(root, "notes.txt") });
		expect(regularRead.content[0]?.text).toContain("published session can read this.");
		await runtime.dispose();
	});

	test("published sessions keep Pi built-ins and MCP tools together", async () => {
		const { backend, root } = await makeHarness();
		const skillDir = join(root, "runtime-skills", "pav_x", "analyze");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "# Analyze\nUse this skill body.");
		const mcpTool: ToolDefinition = {
			name: "mcp_search",
			label: "MCP Search",
			description: "Search through MCP.",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: null }),
		};

		const runtime = await backend.createSession({
			id: "published-mcp-sess",
			model: { provider: "faux", id: "faux-1" },
			customTools: [mcpTool],
			resourceOverrides: {
				systemPrompt: "FROZEN published prompt for pav_x.",
				skills: [
					{
						name: "analyze",
						description: "Answer data questions.",
						filePath: join(skillDir, "SKILL.md"),
						baseDir: skillDir,
						disableModelInvocation: false,
					},
				],
			},
		});

		const session = (
			runtime as unknown as {
				session: { systemPrompt: string; _toolRegistry: Map<string, unknown> };
			}
		).session;
		expect(session.systemPrompt).toContain("<available_skills>");
		expect(session.systemPrompt).toContain("<name>analyze</name>");
		const tools = session._toolRegistry;
		expect([...tools.keys()]).toEqual(
			expect.arrayContaining(["read", "write", "edit", "bash", "grep", "find", "ls", "mcp_search"]),
		);
		await runtime.dispose();
	});

	test("listSessions returns one row when legacy files reuse the same assigned id", async () => {
		const { backend, faux } = await makeHarness();
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const first = await backend.createSession({
			id: "shared-id",
			model: { provider: "faux", id: "faux-1" },
		});
		await first.prompt({ text: "first" });
		await first.dispose();
		const second = await backend.createSession({
			id: "shared-id",
			model: { provider: "faux", id: "faux-1" },
		});
		await second.prompt({ text: "second" });
		await second.dispose();
		const matching = (await backend.listSessions()).filter((session) => session.id === "shared-id");
		expect(matching).toHaveLength(1);
	});

	test("create + prompt streams progress and settles a snapshot", async () => {
		const { backend, faux } = await makeHarness();
		faux.setResponses([
			fauxAssistantMessage([
				{ type: "thinking", thinking: "think step one" },
				{ type: "text", text: "Hello from faux" },
			]),
		]);
		const runtime = await backend.createSession({
			id: "sess-1",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "high",
		});
		expect(runtime.snapshot().id).toBe("sess-1");
		expect(runtime.snapshot().model).toEqual({ provider: "faux", id: "faux-1" });

		let progressCount = 0;
		runtime.subscribe((event) => {
			if (event.type === "progress") progressCount += 1;
		});
		await runtime.prompt({ text: "hi" });

		expect(progressCount).toBeGreaterThan(0);
		const snap = runtime.snapshot();
		expect(snap.phase).toBe("idle");
		expect(snap.transcript.map((t) => t.role)).toEqual(["user", "assistant"]);
		expect(snap.transcript[1].role === "assistant" && snap.transcript[1].content[0].type === "thinking").toBe(true);

		const listed = await backend.listSessions();
		expect(listed.some((s) => s.id === "sess-1" && s.phase === "idle")).toBe(true);
	});

	test("tool call turn produces tool progress and a tool transcript item", async () => {
		const { backend, faux } = await makeHarness();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done reading"),
		]);
		const runtime = await backend.createSession({
			id: "tool-sess",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		const progress: string[] = [];
		runtime.subscribe((event) => {
			if (event.type === "progress") progress.push(event.progress.type);
		});
		await runtime.prompt({ text: "read the file" });
		const snap = runtime.snapshot();
		expect(snap.transcript.map((t) => t.role)).toEqual(["user", "assistant", "tool", "assistant"]);
		expect(snap.transcript[2].role === "tool" && snap.transcript[2].status).toBe("complete");
		expect(progress).toContain("item_started");
		expect(progress).toContain("item_finished");
	});

	test("abort stops a streaming turn and settles to idle with aborted assistant", async () => {
		const { backend, faux } = await makeHarness({ tokensPerSecond: 300 });
		faux.setResponses([fauxAssistantMessage({ type: "text", text: "x".repeat(1500) })]);
		const runtime = await backend.createSession({
			id: "abort-sess",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		const progress: string[] = [];
		const firstDelta = new Promise<void>((resolve) => {
			runtime.subscribe((event) => {
				if (event.type === "progress") progress.push(event.progress.type);
				if (event.type === "progress" && event.progress.type === "assistant_delta") resolve();
			});
		});
		const promptPromise = runtime.prompt({ text: "write a lot" });
		await firstDelta;
		await runtime.abort();
		await promptPromise;
		const snap = runtime.snapshot();
		expect(snap.phase).toBe("idle");
		const last = snap.transcript.at(-1);
		expect(last?.role).toBe("assistant");
		if (last?.role === "assistant") {
			expect(last.status).toBe("aborted");
		}
		expect(progress).toContain("item_finished");
	});

	test("setModel and setThinking update the authoritative snapshot", async () => {
		const { backend } = await makeHarness();
		const runtime = await backend.createSession({
			id: "cfg-sess",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		await runtime.setModel({ provider: "faux", id: "faux-2" });
		expect(runtime.snapshot().model).toEqual({ provider: "faux", id: "faux-2" });
		await runtime.setThinking("high");
		expect(runtime.snapshot().thinkingLevel).toBe("high");
	});

	test("duplicate createSession id rejects with session_locked", async () => {
		const { backend } = await makeHarness();
		await backend.createSession({ id: "dup", model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" });
		await expect(
			backend.createSession({ id: "dup", model: { provider: "faux", id: "faux-1" }, thinkingLevel: "off" }),
		).rejects.toMatchObject({ code: "session_locked" });
	});

	test("openSession for an unknown id rejects with not_found", async () => {
		const { backend } = await makeHarness();
		await expect(backend.openSession("ghost")).rejects.toMatchObject({ code: "not_found" });
	});

	test("reopen after dispose restores the persisted transcript", async () => {
		const { backend, faux } = await makeHarness();
		faux.setResponses([fauxAssistantMessage("reply one")]);
		let runtime = await backend.createSession({
			id: "reopen",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		await runtime.prompt({ text: "hello" });
		const before = runtime.snapshot().transcript;
		expect(before.length).toBeGreaterThan(0);
		await runtime.dispose();

		runtime = await backend.openSession("reopen");
		const after = runtime.snapshot().transcript;
		expect(after.map((t) => `${t.role}:${JSON.stringify(t.content)}`)).toEqual(
			before.map((t) => `${t.role}:${JSON.stringify(t.content)}`),
		);
		await runtime.dispose();
	});

	test("two concurrent sessions do not cross-talk", async () => {
		const { backend, faux } = await makeHarness();
		faux.setResponses([fauxAssistantMessage("reply-A"), fauxAssistantMessage("reply-B")]);
		const a = await backend.createSession({
			id: "a",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		const b = await backend.createSession({
			id: "b",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		const aProgress: string[] = [];
		const bProgress: string[] = [];
		a.subscribe((e) => {
			if (e.type === "progress") aProgress.push(e.progress.type);
		});
		b.subscribe((e) => {
			if (e.type === "progress") bProgress.push(e.progress.type);
		});
		await Promise.all([a.prompt({ text: "hello a" }), b.prompt({ text: "hello b" })]);

		const transcriptA = a.snapshot().transcript;
		const transcriptB = b.snapshot().transcript;
		expect(transcriptA[0].role === "user" && transcriptA[0].content).toContainEqual({
			type: "text",
			text: "hello a",
		});
		expect(transcriptB[0].role === "user" && transcriptB[0].content).toContainEqual({
			type: "text",
			text: "hello b",
		});
		expect(JSON.stringify(transcriptA)).not.toContain("hello b");
		expect(JSON.stringify(transcriptB)).not.toContain("hello a");
		expect(aProgress.length).toBeGreaterThan(0);
		expect(bProgress.length).toBeGreaterThan(0);
	});
});

// ============================================================================
// WebSocket end-to-end tests (real listener + protocol client)
// ============================================================================

describe("coding-agent backend over WebSocket", () => {
	test("hello exposes a server snapshot with the created session and faux model", async () => {
		const { backend } = await makeHarness();
		const url = await startWireServer(backend);
		const a = await connect(url);
		await a.hello();
		const created = await a.request({ command: "create", model: { provider: "faux", id: "faux-1" } });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const sessionId = sessionOf(created.result).id;

		const b = await connect(url);
		const hello = await b.hello();
		if (hello.type !== "hello") return;
		expect(hello.snapshot.sessions.some((s) => s.id === sessionId)).toBe(true);
		expect(hello.snapshot.models.some((m) => m.provider === "faux" && m.id === "faux-1")).toBe(true);
	});

	test("list/create/detach flow over the wire", async () => {
		const { backend, faux } = await makeHarness();
		faux.setResponses([fauxAssistantMessage("reply")]);
		const url = await startWireServer(backend);
		const client = await connect(url);
		await client.hello();

		const created = await client.request({ command: "create", model: { provider: "faux", id: "faux-1" } });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const sessionId = sessionOf(created.result).id;

		// Prompt once so the session materialises on disk (sessions flush when
		// the first assistant message is persisted).
		const prompted = await client.request({ command: "prompt", sessionId, text: "hello" });
		expect(prompted.ok).toBe(true);
		if (!prompted.ok) return;

		const listAfterCreate = await client.request({ command: "list" });
		expect(listAfterCreate.ok).toBe(true);
		if (!listAfterCreate.ok) return;
		expect(sessionsOf(listAfterCreate.result).some((s) => s.id === sessionId && s.attached && s.locked)).toBe(true);

		const detach = await client.request({ command: "detach", sessionId });
		expect(detach.ok).toBe(true);

		const listAfterDetach = await client.request({ command: "list" });
		expect(listAfterDetach.ok).toBe(true);
		if (!listAfterDetach.ok) return;
		expect(sessionsOf(listAfterDetach.result).some((s) => s.id === sessionId)).toBe(true);
	});

	test("ephemeral debug sessions stay out of wire session listings", async () => {
		const { backend } = await makeHarness();
		const url = await startWireServer(backend);
		const client = await connect(url);
		await client.hello();

		const created = await client.request({
			command: "create",
			ephemeral: true,
			model: { provider: "faux", id: "faux-1" },
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const sessionId = sessionOf(created.result).id;
		const listed = await client.request({ command: "list" });
		expect(listed.ok).toBe(true);
		if (!listed.ok) return;
		expect(sessionsOf(listed.result).some((session) => session.id === sessionId)).toBe(false);
	});

	test("prompt streams text and thinking progress then returns the authoritative snapshot", async () => {
		const { backend, faux } = await makeHarness();
		faux.setResponses([
			fauxAssistantMessage([
				{ type: "thinking", thinking: "think step one" },
				{ type: "text", text: "Hello from faux" },
			]),
		]);
		const url = await startWireServer(backend);
		const client = await connect(url);
		await client.hello();
		const created = await client.request({
			command: "create",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "high",
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const sessionId = sessionOf(created.result).id;

		const response = await client.request({ command: "prompt", sessionId, text: "hi" });
		expect(response.ok).toBe(true);
		if (!response.ok) return;
		const kinds: TranscriptProgress[] = [];
		for (const m of client.messages) {
			if (m.type === "event" && m.event.type === "session_progress" && m.event.sessionId === sessionId) {
				kinds.push(m.event.progress);
			}
		}
		expect(kinds.some((p) => p.type === "item_started")).toBe(true);
		expect(kinds.some((p) => p.type === "assistant_delta" && p.kind === "text")).toBe(true);
		expect(kinds.some((p) => p.type === "assistant_delta" && p.kind === "thinking")).toBe(true);
		expect(kinds.some((p) => p.type === "item_finished")).toBe(true);
		const transcript = sessionOf(response.result).transcript;
		expect(transcript.map((t) => t.role)).toEqual(["user", "assistant"]);
		const assistant = transcript[1];
		if (assistant.role !== "assistant") throw new Error("expected an assistant transcript item");
		expect(assistant.content.some((c) => c.type === "thinking")).toBe(true);
		expect(assistant.content.some((c) => c.type === "text")).toBe(true);
	});

	test("tool call turn streams tool progress over the wire", async () => {
		const { backend, faux } = await makeHarness();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done reading"),
		]);
		const url = await startWireServer(backend);
		const client = await connect(url);
		await client.hello();
		const created = await client.request({
			command: "create",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const sessionId = sessionOf(created.result).id;

		const response = await client.request({ command: "prompt", sessionId, text: "read the file" });
		expect(response.ok).toBe(true);
		if (!response.ok) return;
		const transcript = sessionOf(response.result).transcript;
		expect(transcript.map((t) => t.role)).toEqual(["user", "assistant", "tool", "assistant"]);
		const tool = transcript[2];
		expect(tool.role === "tool" && tool.status).toBe("complete");
	});

	test("set_model and set_thinking over the wire update the snapshot", async () => {
		const { backend } = await makeHarness();
		const url = await startWireServer(backend);
		const client = await connect(url);
		await client.hello();
		const created = await client.request({
			command: "create",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const sessionId = sessionOf(created.result).id;

		const model = await client.request({
			command: "set_model",
			sessionId,
			model: { provider: "faux", id: "faux-2" },
		});
		expect(model.ok).toBe(true);
		if (!model.ok) return;
		expect(sessionOf(model.result).model).toEqual({ provider: "faux", id: "faux-2" });

		const thinking = await client.request({ command: "set_thinking", sessionId, thinkingLevel: "high" });
		expect(thinking.ok).toBe(true);
		if (!thinking.ok) return;
		expect(sessionOf(thinking.result).thinkingLevel).toBe("high");
	});

	test("steer queues a message that is applied on the next turn", async () => {
		const { backend, faux } = await makeHarness();
		faux.setResponses([fauxAssistantMessage("reply A"), fauxAssistantMessage("reply B")]);
		const url = await startWireServer(backend);
		const client = await connect(url);
		await client.hello();
		const created = await client.request({
			command: "create",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const sessionId = sessionOf(created.result).id;

		const steered = await client.request({
			command: "steer",
			sessionId,
			text: "remember the magic word: zucchini",
		});
		expect(steered.ok).toBe(true);

		const prompted = await client.request({ command: "prompt", sessionId, text: "go" });
		expect(prompted.ok).toBe(true);
		if (!prompted.ok) return;
		const userItems = sessionOf(prompted.result)
			.transcript.filter((t): t is Extract<typeof t, { role: "user" }> => t.role === "user")
			.map((t) => JSON.stringify(t.content));
		expect(userItems.some((c) => c.includes("zucchini"))).toBe(true);
	});

	test("abort over the wire stops the turn and returns an idle aborted snapshot", async () => {
		const { backend, faux } = await makeHarness({ tokensPerSecond: 300 });
		faux.setResponses([fauxAssistantMessage({ type: "text", text: "x".repeat(1500) })]);
		const url = await startWireServer(backend);
		const client = await connect(url);
		await client.hello();
		const created = await client.request({
			command: "create",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const sessionId = sessionOf(created.result).id;

		const promptPromise = client.request({ command: "prompt", sessionId, text: "write a lot" });
		const firstDelta = client.next(
			(m) =>
				m.type === "event" &&
				m.event.type === "session_progress" &&
				m.event.sessionId === sessionId &&
				m.event.progress.type === "assistant_delta",
		);
		await firstDelta;
		const aborted = await client.request({ command: "abort", sessionId });
		expect(aborted.ok).toBe(true);
		if (!aborted.ok) return;
		expect(sessionOf(aborted.result).phase).toBe("idle");
		const last = sessionOf(aborted.result).transcript.at(-1);
		expect(last?.role === "assistant" && last.status).toBe("aborted");
		await promptPromise;
	});

	test("attach for an unknown session rejects with not_found", async () => {
		const { backend } = await makeHarness();
		const url = await startWireServer(backend);
		const client = await connect(url);
		await client.hello();
		const response = await client.request({ command: "attach", sessionId: "missing-session" });
		expect(response.ok).toBe(false);
		if (!response.ok) expect(response.error.code).toBe("not_found");
	});

	test("a second prompt while a turn is running is rejected, not queued", async () => {
		const { backend, faux } = await makeHarness({ tokensPerSecond: 300 });
		faux.setResponses([fauxAssistantMessage({ type: "text", text: "x".repeat(1500) })]);
		const url = await startWireServer(backend);
		const client = await connect(url);
		await client.hello();
		const created = await client.request({
			command: "create",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const sessionId = sessionOf(created.result).id;

		const promptPromise = client.request({ command: "prompt", sessionId, text: "first" });
		const firstDelta = client.next(
			(m) =>
				m.type === "event" &&
				m.event.type === "session_progress" &&
				m.event.sessionId === sessionId &&
				m.event.progress.type === "assistant_delta",
		);
		await firstDelta;
		const second = await client.request({ command: "prompt", sessionId, text: "second" });
		expect(second.ok).toBe(false);
		if (!second.ok) expect(["busy", "invalid_request"]).toContain(second.error.code);
		await promptPromise;
	});

	test("reconnecting and re-attaching restores the persisted transcript", async () => {
		const { backend, faux } = await makeHarness();
		faux.setResponses([fauxAssistantMessage("reply one")]);
		const url = await startWireServer(backend);

		const a = await connect(url);
		await a.hello();
		const created = await a.request({
			command: "create",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const sessionId = sessionOf(created.result).id;
		const first = await a.request({ command: "prompt", sessionId, text: "hello" });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const transcript = sessionOf(first.result).transcript;
		expect(transcript.length).toBeGreaterThan(0);
		await a.close();

		const b = await connect(url);
		await b.hello();
		const attached = await b.request({ command: "attach", sessionId });
		expect(attached.ok).toBe(true);
		if (!attached.ok) return;
		expect(sessionOf(attached.result).transcript).toEqual(transcript);
	});

	test("reconnecting with resume replays missed progress and aligns the transcript", async () => {
		const { backend, faux } = await makeHarness();
		faux.setResponses([fauxAssistantMessage("reply one")]);
		const url = await startWireServer(backend);

		const a = await connect(url);
		await a.hello();
		const created = await a.request({
			command: "create",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const sessionId = sessionOf(created.result).id;

		const first = await a.request({ command: "prompt", sessionId, text: "hello" });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const seenOnA = a.messages
			.filter((m) => m.type === "event" && m.event.type === "session_progress")
			.map((m) => (m as { event: { sequence: number } }).event.sequence);
		expect(seenOnA.length).toBeGreaterThan(0);
		const lastOnA = Math.max(...seenOnA);
		await a.close();

		const b = await connect(url);
		await b.hello();
		const afterSequence = Math.max(1, lastOnA - 1);
		const response = b.next((m) => m.type === "response" && m.id === "resume-1");
		await b.sendMessage({
			type: "request",
			id: "resume-1",
			request: { command: "resume", sessionId, afterSequence },
		});
		const resumed = (await response) as ResponseEnvelope;
		expect(resumed).toMatchObject({ type: "response", id: "resume-1", ok: true });
		if (!resumed.ok || resumed.result.command !== "resume") throw new Error("Expected resume result");
		const replayed = b.messages
			.filter((m) => m.type === "event" && m.event.type === "session_progress")
			.map((m) => (m as { event: { sequence: number } }).event.sequence);
		expect(replayed).toEqual(seenOnA.filter((sequence) => sequence > afterSequence));
		expect(resumed.result).toMatchObject({ command: "resume", replayedThrough: lastOnA, resetRequired: false });

		const transcript = sessionOf(resumed.result).transcript;
		const assistant = transcript.at(-1);
		expect(assistant?.role).toBe("assistant");
		if (assistant?.role !== "assistant") throw new Error("Expected an assistant transcript item");
		expect(assistant.content.some((c) => c.type === "text" && c.text === "reply one")).toBe(true);
	});

	test("two clients with two sessions receive no cross-talk", async () => {
		const { backend, faux } = await makeHarness();
		faux.setResponses([fauxAssistantMessage("reply-A"), fauxAssistantMessage("reply-B")]);
		const url = await startWireServer(backend);

		const a = await connect(url);
		const b = await connect(url);
		await a.hello();
		await b.hello();
		const createdA = await a.request({
			command: "create",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		const createdB = await b.request({
			command: "create",
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
		});
		expect(createdA.ok && createdB.ok).toBe(true);
		if (!createdA.ok || !createdB.ok) return;
		const idA = sessionOf(createdA.result).id;
		const idB = sessionOf(createdB.result).id;

		const [resultA, resultB] = await Promise.all([
			a.request({ command: "prompt", sessionId: idA, text: "hello a" }),
			b.request({ command: "prompt", sessionId: idB, text: "hello b" }),
		]);
		expect(resultA.ok && resultB.ok).toBe(true);
		if (!resultA.ok || !resultB.ok) return;

		const progressIdsA = new Set(
			a.messages
				.filter((m) => m.type === "event" && m.event.type === "session_progress")
				.map((m) => (m as { event: { sessionId: string } }).event.sessionId),
		);
		const progressIdsB = new Set(
			b.messages
				.filter((m) => m.type === "event" && m.event.type === "session_progress")
				.map((m) => (m as { event: { sessionId: string } }).event.sessionId),
		);
		expect(progressIdsA.has(idB)).toBe(false);
		expect(progressIdsB.has(idA)).toBe(false);

		const firstUserA = sessionOf(resultA.result).transcript[0];
		const firstUserB = sessionOf(resultB.result).transcript[0];
		if (firstUserA.role !== "user" || firstUserB.role !== "user") throw new Error("expected user transcript items");
		expect(firstUserA.content.some((c) => c.type === "text" && c.text === "hello a")).toBe(true);
		expect(firstUserB.content.some((c) => c.type === "text" && c.text === "hello b")).toBe(true);
	});
});
