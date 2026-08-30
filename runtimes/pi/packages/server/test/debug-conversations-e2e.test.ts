/**
 * Debug Conversations — real WebSocket E2E over a REAL server + real Postgres.
 *
 * Binds a real `PiServer` (LiveSessionManager) + `createWebSocketServer`
 * listener with a real `DebugConversationRuntimeAdapter` (via
 * `createDebugRealtimeBackend`), and the real DebugConversation HTTP controller
 * over a real `node:http` listener, then drives them with a real
 * `connectWebSocketTestClient` + `fetch`. Only the innermost LLM session is a
 * stub (blocking deterministically on demand) — no real model provider is
 * reachable.
 *
 * This is the close-out gate before switching the Agent Debug main path:
 *   A. strict lazy-create (open creates nothing; first message creates)
 *   B. cancel -> single turn/interrupted; no end/failed for that turn; next turn
 *   C. reload/reconnect -> snapshot rebuilt from DB; T3 streams
 *   D. revision change -> same conversation, realtime turnId == persisted,
 *      history preserved, streams
 *   E. multi-tab -> both connections receive progress; concurrent prompt is
 *      rejected (single active Turn per conversation)
 * Skipped automatically when the test Postgres is unreachable.
 */
import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresClient } from "../src/persistence/postgres/client.ts";
import { runMigrations } from "../src/persistence/postgres/migrate.ts";
import { createDebugRepositories } from "../src/persistence/postgres/repositories/debug.ts";
import { createAdminDebugConversationHandler } from "../src/publishing/debug/http.ts";
import { createDebugRealtimeBackend, DebugConversationRealtime } from "../src/publishing/debug/realtime.ts";
import { DebugConversationService } from "../src/publishing/debug/service.ts";
import type { DebugRepositories } from "../src/publishing/debug/types.ts";
import {
	type AgentDefinitionId,
	type DebugConversationId,
	fromPublicId,
	newAgentDefinitionId,
	type PrincipalId,
	type TenantId,
	toPublicId,
} from "../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../src/publishing/repositories.ts";
import type { CapabilityCatalog } from "../src/publishing/runtime-spec/compiler.ts";
import { connectWebSocketTestClient, type ProtocolTestClient } from "../src/testing/index.ts";
import { createWebSocketServer } from "../src/transports/websocket/index.ts";
import type { PiSessionBackend, PiSessionRuntime, PiSessionRuntimeEvent, PromptInput } from "../src/types.ts";

const SCHEMA = `dce2e_${process.pid}_${Date.now().toString(36)}`;
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

const TENANT_ID = "11111111-1111-7111-8111-111111111111" as TenantId;
const OWNER = "22222222-2222-7222-8222-222222222222" as PrincipalId;

const MODEL_A = { provider: "prov", modelId: "modelA" };
const MODEL_B = { provider: "prov", modelId: "modelB" };
const CATALOG: CapabilityCatalog = {
	tools: [],
	knowledgeBases: [],
	models: [
		{
			provider: MODEL_A.provider,
			modelId: MODEL_A.modelId,
			parameterCapabilities: {
				reasoning: { supported: true, toggle: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
			},
		},
		{
			provider: MODEL_B.provider,
			modelId: MODEL_B.modelId,
			parameterCapabilities: {
				reasoning: { supported: true, toggle: true, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
			},
		},
	],
};

interface E2ECapture {
	created: number;
	prompts: PromptInput[];
	/** Set to make the next inner prompt block until abort. */
	blockNext: boolean;
	releases: (() => void) | null;
}

function freshAgent(): { agentId: AgentDefinitionId; agentPublic: string } {
	const agentId = (fromPublicId("AgentDefinitionId", `agent_${newAgentDefinitionId()}`) ??
		newAgentDefinitionId()) as AgentDefinitionId;
	return { agentId, agentPublic: toPublicId("AgentDefinitionId", agentId) };
}

function internalConvId(convPublic: string): DebugConversationId {
	const id = fromPublicId("DebugConversationId", convPublic);
	if (id === null) throw new Error(`not a debug conversation id: ${convPublic}`);
	return id;
}

function revisionRecord(rev: { revision: number; model: { provider: string; modelId: string } }): unknown {
	return { revision: rev.revision, draftConfig: { prompt: `system prompt rev ${rev.revision}`, model: rev.model } };
}

function makePublishing(): {
	repositories: PublishingRepositories;
	advanceRevision(): void;
} {
	const revisions = [
		{ revision: 1, model: MODEL_A },
		{ revision: 2, model: MODEL_B },
	];
	let cursor = 0;
	return {
		repositories: {
			agentDefinitions: { getLatest: async () => revisionRecord(revisions[cursor]!) },
			skills: { listBindings: async () => [], get: async () => undefined, getRevision: async () => undefined },
			mcpServers: {
				listBindings: async () => [],
				get: async () => undefined,
				getRevision: async () => undefined,
				listTools: async () => [],
			},
		} as unknown as PublishingRepositories,
		advanceRevision: () => {
			cursor += 1;
		},
	};
}

/** Stub inner LLM session (blocks on demand so the abort path is exercised). */
function makeInnerFactory(capture: E2ECapture): (opts: unknown) => Promise<PiSessionRuntime> {
	return async (opts: unknown) => {
		capture.created += 1;
		const id = (opts as { id: string }).id;
		const items: Array<Record<string, unknown>> = [];
		const listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
		const emit = (event: PiSessionRuntimeEvent) => {
			for (const listener of [...listeners]) listener(event);
		};
		return {
			ephemeral: true,
			snapshot: () => ({ id, transcript: items }) as unknown as ReturnType<PiSessionRuntime["snapshot"]>,
			getPhase: () => "idle" as const,
			async prompt(input: PromptInput) {
				capture.prompts.push(input);
				const messageId = `inner-ast:${input.text}`;
				emit({
					type: "progress",
					progress: {
						type: "item_started",
						item: {
							id: messageId,
							role: "assistant",
							model: { provider: "prov", id: "modelA" },
							status: "streaming",
							content: [],
							timestamp: Date.now(),
						},
					},
				});
				emit({
					type: "progress",
					progress: { type: "assistant_delta", messageId, contentIndex: 0, kind: "text", delta: "Hello" },
				});
				emit({
					type: "progress",
					progress: { type: "assistant_delta", messageId, contentIndex: 0, kind: "text", delta: " World" },
				});
				if (capture.blockNext) {
					capture.blockNext = false;
					await new Promise<void>((resolve) => {
						capture.releases = resolve;
					});
				}
				const text = `echo:${input.text}`;
				items.push({
					role: "assistant",
					status: "complete",
					content: [
						{ type: "text", text },
						{ type: "thinking", redacted: false, thinking: "x" },
					],
				});
				emit({
					type: "progress",
					progress: {
						type: "item_finished",
						item: {
							id: messageId,
							role: "assistant",
							model: { provider: "prov", id: "modelA" },
							status: "complete",
							stopReason: "stop",
							content: [{ type: "text", text }],
							timestamp: Date.now(),
						},
					},
				});
			},
			async steer() {},
			async abort() {
				capture.releases?.();
				capture.releases = null;
			},
			async setModel() {},
			async setThinking() {},
			subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			async dispose() {},
		};
	};
}

async function makeService(
	store: DebugRepositories,
	capture: E2ECapture,
	publishing: ReturnType<typeof makePublishing>,
): Promise<{ service: DebugConversationService; realtime: DebugConversationRealtime }> {
	const service = new DebugConversationService({
		repositories: publishing.repositories,
		debug: store,
		catalog: CATALOG,
		createSession: makeInnerFactory(capture),
		tenantId: TENANT_ID,
		ownerPrincipalId: OWNER,
	});
	return { service, realtime: new DebugConversationRealtime(service) };
}

/** Real WS server (real PiServer/LiveSessionManager/adapter) + real debug HTTP. */
async function startStack(
	service: DebugConversationService,
	realtime: DebugConversationRealtime,
): Promise<{
	wsServer: ReturnType<typeof createWebSocketServer>;
	wsUrl: string;
	httpServer: http.Server;
	httpUrl: string;
}> {
	const innerBackend: PiSessionBackend = {
		listSessions: async () => [],
		listModels: async () => [],
		createSession: async () => {
			throw new Error("not used in the debug e2e path");
		},
		openSession: async () => {
			throw new Error("not used in the debug e2e path");
		},
	};
	const wsServer = createWebSocketServer(createDebugRealtimeBackend(innerBackend, realtime), { port: 0 });
	await wsServer.start();
	const wsPort = Number(wsServer.addresses[0]!.slice(wsServer.addresses[0]!.lastIndexOf(":") + 1));
	const handler = createAdminDebugConversationHandler({ service, isAuthorized: () => true });
	const httpServer = http.createServer((req, res) => {
		Promise.resolve(handler(req, res)).then((handled) => {
			if (handled) return;
			res.writeHead(404).end("not found");
		});
	});
	await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	const hp = (httpServer.address() as { port: number }).port;
	return { wsServer, wsUrl: `ws://127.0.0.1:${wsPort}/api/pi/v1/ws`, httpServer, httpUrl: `http://127.0.0.1:${hp}` };
}

function closeHttp(server: http.Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

async function httpJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
	const res = await fetch(url, init);
	return { status: res.status, body: (await res.json()) as any };
}

function transcriptTexts(snapshot: {
	transcript?: ReadonlyArray<{ role: string; content: ReadonlyArray<{ type: string; text?: string }> }>;
}): string[] {
	return (snapshot.transcript ?? []).flatMap((item) =>
		item.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")),
	);
}

const isTerminal = (e: { eventType: string }): boolean =>
	e.eventType === "turn/end" || e.eventType === "turn/failed" || e.eventType === "turn/interrupted";

function sessionProgressTurnIds(client: ProtocolTestClient): string[] {
	return client.messages
		.filter((m) => (m as any).type === "event" && (m as any).event?.type === "session_progress")
		.map((m) => (m as any).event.turnId as string);
}

const DEBUG_BASE = "/api/control/v1/debug-conversations";

describe.skipIf(!pgUp)("DebugConversations realtime WS E2E (real server + PG)", () => {
	let client: PostgresClient;
	let store: DebugRepositories;
	let capture: E2ECapture;
	let publishing: ReturnType<typeof makePublishing>;
	let service: DebugConversationService;
	let realtime: DebugConversationRealtime;
	let stack: Awaited<ReturnType<typeof startStack>>;
	let httpBase: string;

	const openedClients: ProtocolTestClient[] = [];
	const startedServers: Array<ReturnType<typeof createWebSocketServer>> = [];
	const startedHttp: http.Server[] = [];

	async function wsConnect(): Promise<ProtocolTestClient> {
		const c = await connectWebSocketTestClient(stack.wsUrl);
		openedClients.push(c);
		await c.hello();
		return c;
	}

	async function resumeConversation(
		agentPublic: string,
	): Promise<{ convPublic: string; convId: DebugConversationId } | null> {
		const res = await httpJson(`${httpBase}${DEBUG_BASE}?agentId=${agentPublic}`);
		const conv = (res.body as { data: { conversation: { conversationId: string } | null } }).data.conversation;
		if (conv === null) return null;
		return { convPublic: conv.conversationId, convId: internalConvId(conv.conversationId) };
	}

	async function createConversation(
		agentPublic: string,
	): Promise<{ convPublic: string; convId: DebugConversationId }> {
		const res = await httpJson(`${httpBase}${DEBUG_BASE}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agentId: agentPublic }),
		});
		expect(res.status).toBe(201);
		const convPublic: string = (res.body as { data: { conversation: { conversationId: string } } }).data.conversation
			.conversationId;
		return { convPublic, convId: internalConvId(convPublic) };
	}

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		store = createDebugRepositories(client);

		capture = { created: 0, prompts: [], blockNext: false, releases: null };
		publishing = makePublishing();
		({ service, realtime } = await makeService(store, capture, publishing));
		stack = await startStack(service, realtime);
		startedServers.push(stack.wsServer);
		startedHttp.push(stack.httpServer);
		httpBase = stack.httpUrl;
	});

	afterAll(async () => {
		for (const c of openedClients) await c.close().catch(() => {});
		for (const s of startedServers) await s.close().catch(() => {});
		for (const s of startedHttp) await closeHttp(s).catch(() => {});
		await client?.run(`drop schema if exists ${SCHEMA} cascade`).catch(() => {});
		await client?.close().catch(() => {});
	});

	it("A. strict lazy-create: open creates nothing; the first message creates + attaches then streams", async () => {
		const { agentId, agentPublic } = freshAgent();
		// "Open Debug" for a bound Agent that has never been used: resume returns
		// no conversation (and the DB has no row) — nothing is created.
		expect(await resumeConversation(agentPublic)).toBeNull();
		expect(
			await store.conversations.getRecentActive({ tenantId: TENANT_ID, ownerPrincipalId: OWNER, agentId }),
		).toBeUndefined();

		// First real message: create via real HTTP, then attach + prompt via real WS.
		const { convPublic, convId } = await createConversation(agentPublic);
		const clientA = await wsConnect();
		const attach = await clientA.request({ command: "attach", sessionId: convPublic } as never);
		expect(attach.ok).toBe(true);
		expect((attach as any).result.session.transcript).toHaveLength(0);

		const prompt = await clientA.request({ command: "prompt", sessionId: convPublic, text: "hello" } as never);
		expect(prompt.ok).toBe(true);

		// Streaming reached the WS (realtime), and exactly one normal terminal.
		expect(
			clientA.messages.filter((m) => (m as any).event?.progress?.type === "assistant_delta").length,
		).toBeGreaterThan(0);
		const after = await service.listEvents(convId);
		expect(after.map((e) => e.eventType)).toEqual(["turn/start", "user/message", "assistant/message", "turn/end"]);
		const persisted = new Set(
			after
				.map((e) => e.turnId)
				.filter((t) => t !== null)
				.map((t) => t as string),
		);
		const realtimeTurnIds = new Set(sessionProgressTurnIds(clientA));
		expect(realtimeTurnIds.size).toBe(1);
		expect([...realtimeTurnIds]).toEqual([...persisted]);
	});

	it("B. cancel writes exactly ONE turn/interrupted (no end/failed for that turn); the next turn streams", async () => {
		const { agentPublic } = freshAgent();
		const { convPublic, convId } = await createConversation(agentPublic);
		const clientB = await wsConnect();
		await clientB.request({ command: "attach", sessionId: convPublic } as never);

		capture.blockNext = true;
		const slow = clientB.request({ command: "prompt", sessionId: convPublic, text: "slow" } as never);
		await new Promise((resolve) => setTimeout(resolve, 60));
		const abort = await clientB.request({ command: "abort", sessionId: convPublic } as never);
		expect(abort.ok).toBe(true);
		await slow;

		const events = await service.listEvents(convId);
		const interrupted = events.find((e) => e.eventType === "turn/interrupted");
		expect(interrupted).toBeTruthy();
		// The interrupted turn has a SINGLE terminal and nothing else — never
		// end/failed alongside interrupted.
		const interTurnId = interrupted!.turnId;
		expect(interTurnId).not.toBeNull();
		expect(events.filter((e) => isTerminal(e) && e.turnId === interTurnId).map((e) => e.eventType)).toEqual([
			"turn/interrupted",
		]);

		// The realtime frames for the interrupted turn carry the same durable id.
		expect(sessionProgressTurnIds(clientB)).toContain(interTurnId as string);

		// Next turn streams normally on the same conversation.
		const next = await clientB.request({ command: "prompt", sessionId: convPublic, text: "after cancel" } as never);
		expect(next.ok).toBe(true);
		const after = await service.listEvents(convId);
		expect(after.filter((e) => e.eventType === "turn/end").length).toBe(1);
	});

	it("C. reload / reconnect: a fresh server rebuilds the transcript from DB and streams", async () => {
		const { agentPublic } = freshAgent();
		const { convPublic, convId } = await createConversation(agentPublic);

		// T1, T2 on the current server.
		const c1 = await wsConnect();
		await c1.request({ command: "attach", sessionId: convPublic } as never);
		for (const text of ["T1", "T2"]) {
			const r = await c1.request({ command: "prompt", sessionId: convPublic, text } as never);
			expect(r.ok).toBe(true);
		}
		await c1.close();

		// "Reload": a brand-new server instance over the SAME Postgres (empty
		// runtime + adapter + LiveSession caches) re-attaches and rebuilds the
		// snapshot from persisted events.
		const fresh = await makeService(store, { created: 0, prompts: [], blockNext: false, releases: null }, publishing);
		const freshStack = await startStack(fresh.service, fresh.realtime);
		startedServers.push(freshStack.wsServer);
		startedHttp.push(freshStack.httpServer);

		const c2 = await connectWebSocketTestClient(freshStack.wsUrl);
		openedClients.push(c2);
		await c2.hello();
		const attach = await c2.request({ command: "attach", sessionId: convPublic } as never);
		expect(attach.ok).toBe(true);
		const restored = transcriptTexts((attach as any).result.session);
		expect(restored).toContain("T1");
		expect(restored).toContain("echo:T1");
		expect(restored).toContain("T2");
		expect(restored).toContain("echo:T2");

		const t3 = await c2.request({ command: "prompt", sessionId: convPublic, text: "T3" } as never);
		expect(t3.ok).toBe(true);
		const after = await fresh.service.listEvents(convId);
		expect(
			after.filter((e) => e.eventType === "assistant/message").map((e) => (e.payload as { text?: string }).text),
		).toContain("echo:T3");
	});

	it("D. revision change keeps conversation identity, realtime turnId == persisted, history preserved, streams", async () => {
		const { agentPublic } = freshAgent();
		const { convPublic, convId } = await createConversation(agentPublic);
		const c = await wsConnect();
		await c.request({ command: "attach", sessionId: convPublic } as never);

		const r1 = await c.request({ command: "prompt", sessionId: convPublic, text: "at rev1" } as never);
		expect(r1.ok).toBe(true);

		// Save a new revision; the conversation + WS identity must not change.
		publishing.advanceRevision();
		const r2 = await c.request({ command: "prompt", sessionId: convPublic, text: "at rev2" } as never);
		expect(r2.ok).toBe(true);

		const events = await service.listEvents(convId);
		const starts = events.filter((e) => e.eventType === "turn/start");
		expect(starts.length).toBe(2);
		// Turn 2 turn/start.agentRevisionId = rev2; turn 1's = rev1.
		const t1start = starts[0]!;
		const t2start = starts[1]!;
		expect((t1start.payload as { agentRevisionId?: number }).agentRevisionId).toBe(1);
		expect((t2start.payload as { agentRevisionId?: number }).agentRevisionId).toBe(2);

		// History (turn 1's user text) is injected into the rev-2 inner prompt.
		const lastPrompt = capture.prompts[capture.prompts.length - 1]!;
		expect((lastPrompt.retrieval?.context ?? "").includes("at rev1")).toBe(true);

		// Every realtime frame turnId is one of the persisted turnIds.
		const persistedTurnIds = new Set(
			events
				.map((e) => e.turnId)
				.filter((t) => t !== null)
				.map((t) => t as string),
		);
		for (const frameTurnId of sessionProgressTurnIds(c)) expect(persistedTurnIds.has(frameTurnId)).toBe(true);
		// Streaming still reached the WS after the inner runtime rebuild.
		expect(c.messages.filter((m) => (m as any).event?.progress?.type === "assistant_delta").length).toBeGreaterThan(
			0,
		);
	});

	it("F. Agent A -> Agent B: each agent owns its own conversation; B never reuses A's", async () => {
		const agentA = freshAgent();
		const { convPublic: aPublic, convId: aId } = await createConversation(agentA.agentPublic);

		// Use A's conversation (a real turn in it).
		const c = await wsConnect();
		await c.request({ command: "attach", sessionId: aPublic } as never);
		expect((await c.request({ command: "prompt", sessionId: aPublic, text: "in agent A" } as never)).ok).toBe(true);
		expect(await service.listEvents(aId)).not.toHaveLength(0);

		// A different Agent (same owner) has its OWN conversation: resume -> null
		// and no DB row; no reuse of A's conversation id.
		const agentB = freshAgent();
		expect(await resumeConversation(agentB.agentPublic)).toBeNull();
		expect(
			await store.conversations.getRecentActive({
				tenantId: TENANT_ID,
				ownerPrincipalId: OWNER,
				agentId: agentB.agentId,
			}),
		).toBeUndefined();
		const b = await createConversation(agentB.agentPublic);
		expect(b.convId).not.toBe(aId);
		expect(b.convPublic).not.toBe(aPublic);
	});

	it("E. multi-tab: both connections see progress; a concurrent prompt is rejected (busy)", async () => {
		const { agentPublic } = freshAgent();
		const { convPublic, convId } = await createConversation(agentPublic);

		const tabA = await wsConnect();
		const tabB = await wsConnect();
		expect((await tabA.request({ command: "attach", sessionId: convPublic } as never)).ok).toBe(true);
		expect((await tabB.request({ command: "attach", sessionId: convPublic } as never)).ok).toBe(true);

		// Tab A starts a long-running turn (inner engine blocks).
		capture.blockNext = true;
		const beforeA = tabA.messages.length;
		const beforeB = tabB.messages.length;
		const promA = tabA.request({ command: "prompt", sessionId: convPublic, text: "concurrent" } as never);
		await new Promise((resolve) => setTimeout(resolve, 60));

		// Tab B prompts concurrently -> the server rejects (single active Turn).
		const promB = await tabB.request({ command: "prompt", sessionId: convPublic, text: "oops" } as never);
		if (promB.ok) throw new Error("expected the concurrent prompt to be rejected");
		expect((promB.error as { code?: string }).code).toBe("busy");

		// Both tabs received the streaming progress from tab A's turn.
		const progA = tabA.messages.slice(beforeA).filter((m) => (m as any).event?.progress?.type === "assistant_delta");
		const progB = tabB.messages.slice(beforeB).filter((m) => (m as any).event?.progress?.type === "assistant_delta");
		expect(progA.length).toBeGreaterThan(0);
		expect(progB.length).toBeGreaterThan(0);

		// Abort tab A's turn, then tab B can run normally.
		await tabA.request({ command: "abort", sessionId: convPublic } as never);
		await promA;
		const later = await tabB.request({ command: "prompt", sessionId: convPublic, text: "now ok" } as never);
		expect(later.ok).toBe(true);
		// Tab B's normal turn persisted a terminal.
		const after = await service.listEvents(convId);
		expect(after.filter((e) => isTerminal(e)).length).toBeGreaterThan(0);
	});
});
