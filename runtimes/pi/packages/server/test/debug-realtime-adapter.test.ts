/**
 * Debug Conversation Realtime (Phase 2, Option A) tests — in-memory fakes,
 * no Postgres.
 *
 * Drives `DebugConversationRuntimeAdapter` (a `PiSessionRuntime`) over the
 * existing DebugConversationService. Verifies the P0 vertical slice:
 *   A. streaming (assistant_delta + final assistant + turn/end)
 *   B. cancel -> single `turn/interrupted`, no turn/end/failed, next turn runs
 *   C. revision change -> same conversation + adapter identity, rebuilt inner
 *      runtime, preserved history, continued streaming
 *   D. reconnect / cache loss -> snapshot rebuilt from events, next turn works
 *   E. authorization -> a different tenant/owner cannot attach a conversation
 */
import { describe, expect, it } from "vitest";
import { DebugConversationRealtime } from "../src/publishing/debug/realtime.ts";
import { DebugConversationService } from "../src/publishing/debug/service.ts";
import type {
	DebugConversationEventRecord,
	DebugConversationRecord,
	DebugRepositories,
} from "../src/publishing/debug/types.ts";
import {
	type AgentDefinitionId,
	fromPublicId,
	newAgentDefinitionId,
	type PrincipalId,
	type TenantId,
} from "../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../src/publishing/repositories.ts";
import type { CapabilityCatalog } from "../src/publishing/runtime-spec/compiler.ts";
import type { PiSessionRuntime, PiSessionRuntimeEvent, PromptInput } from "../src/types.ts";

const TENANT_A = "11111111-1111-7111-8111-111111111111" as TenantId;
const TENANT_B = "99999999-9999-7999-8999-999999999999" as TenantId;
const OWNER_A = "22222222-2222-7222-8222-222222222222" as PrincipalId;
const OWNER_B = "88888888-8888-7888-8888-888888888888" as PrincipalId;
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

const AGENT_ID = (fromPublicId("AgentDefinitionId", `agent_${newAgentDefinitionId()}`) ??
	newAgentDefinitionId()) as AgentDefinitionId;

interface Capture {
	created: number;
	prompts: PromptInput[];
	blockOnPrompt: boolean;
	/** When true the fake streams a `thinking` delta and finishes with a thinking part. */
	emitThinking: boolean;
}

interface FakeSession extends PiSessionRuntime {
	releaseBlockedPrompt(): void;
}

function makeSessionFactory(capture: Capture): (opts: unknown) => Promise<FakeSession> {
	return async (opts: unknown) => {
		capture.created += 1;
		const id = (opts as { id: string }).id;
		const items: Array<Record<string, unknown>> = [];
		const listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
		let release: (() => void) | undefined;
		const emit = (event: PiSessionRuntimeEvent) => {
			for (const listener of [...listeners]) listener(event);
		};
		const session: FakeSession = {
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
				if (capture.emitThinking) {
					emit({
						type: "progress",
						progress: {
							type: "assistant_delta",
							messageId,
							contentIndex: 0,
							kind: "thinking",
							delta: "considered",
						},
					});
				}
				if (capture.blockOnPrompt) {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				}
				const text = `echo:${input.text}`;
				const contentParts: Array<Record<string, unknown>> = [{ type: "text", text }];
				if (capture.emitThinking) contentParts.push({ type: "thinking", redacted: false, thinking: "considered" });
				items.push({ role: "assistant", status: "complete", content: contentParts });
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
							content: contentParts,
							timestamp: Date.now(),
						},
					},
				});
			},
			async steer() {},
			async abort() {
				release?.();
			},
			async setModel() {},
			async setThinking() {},
			subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			async dispose() {},
			releaseBlockedPrompt() {
				release?.();
			},
		};
		return session;
	};
}

function makeDebugRepos(): DebugRepositories {
	const byId = new Map<string, DebugConversationRecord>();
	const eventsByConv = new Map<string, DebugConversationEventRecord[]>();
	const eventCounters = new Map<string, number>();
	return {
		conversations: {
			async insert(record) {
				byId.set(record.debugConversationId, record);
				eventCounters.set(record.debugConversationId, 0);
			},
			async getRecentActive(scope) {
				let best: DebugConversationRecord | undefined;
				for (const rec of byId.values()) {
					if (
						rec.tenantId === scope.tenantId &&
						rec.ownerPrincipalId === scope.ownerPrincipalId &&
						rec.agentId === scope.agentId &&
						rec.status === "active"
					) {
						if (best === undefined || rec.lastActiveAt > best.lastActiveAt) best = rec;
					}
				}
				return best;
			},
			async getByRef(scope) {
				const record = byId.get(scope.debugConversationId);
				if (record === undefined || record.tenantId !== scope.tenantId) return undefined;
				return record;
			},
			async setStatus(scope, status) {
				const rec = byId.get(scope.debugConversationId);
				if (rec === undefined || rec.tenantId !== scope.tenantId || rec.status !== "active") return false;
				(rec as { status: string }).status = status;
				return true;
			},
		},
		events: {
			async append(_scope, conversationId, input) {
				const next = (eventCounters.get(conversationId) ?? 0) + 1;
				eventCounters.set(conversationId, next);
				const event = record(conversationId, next, input);
				const list = eventsByConv.get(conversationId) ?? [];
				list.push(event);
				eventsByConv.set(conversationId, list);
				return event;
			},
			async list(scope, params) {
				const list = eventsByConv.get(scope.debugConversationId) ?? [];
				return list.filter((e) => e.sequence > (params.afterSequence ?? 0)).slice(0, params.limit);
			},
		},
	};
}

function record(
	conversationId: DebugConversationRecord["debugConversationId"],
	sequence: number,
	input: {
		eventType: string;
		turnId?: DebugConversationEventRecord["turnId"];
		payload?: unknown;
		eventSchemaVersion?: number;
	},
): DebugConversationEventRecord {
	return {
		eventId: `devt_${sequence}` as DebugConversationEventRecord["eventId"],
		debugConversationId: conversationId,
		sequence,
		eventType: input.eventType,
		eventSchemaVersion: input.eventSchemaVersion ?? 1,
		turnId: input.turnId ?? null,
		payload: input.payload,
		createdAt: new Date(),
	};
}

interface PublishingFake {
	repositories: PublishingRepositories;
	advanceRevision(): void;
}

function makePublishing(
	revisions: Array<{
		revision: number;
		model: { provider: string; modelId: string };
		params?: { reasoning?: { enabled?: boolean; effort?: string } };
	}>,
): PublishingFake {
	let cursor = 0;
	return {
		repositories: {
			agentDefinitions: {
				getLatest: async () => revisionRecord(revisions[cursor]!),
			},
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

function revisionRecord(rev: {
	revision: number;
	model: { provider: string; modelId: string };
	params?: { reasoning?: { enabled?: boolean; effort?: string } };
}): unknown {
	return {
		revision: rev.revision,
		draftConfig: {
			prompt: `system prompt rev ${rev.revision}`,
			model: {
				...rev.model,
				...(rev.params !== undefined ? { params: rev.params } : {}),
			},
		},
	};
}

function makeService(
	repos: DebugRepositories,
	publishing: PublishingFake,
	tenantId: TenantId,
	ownerPrincipalId: PrincipalId,
	capture?: Capture,
): { service: DebugConversationService; realtime: DebugConversationRealtime; capture: Capture } {
	const cap = capture ?? { created: 0, prompts: [], blockOnPrompt: false, emitThinking: false };
	const service = new DebugConversationService({
		repositories: publishing.repositories,
		debug: repos,
		catalog: CATALOG,
		createSession: makeSessionFactory(cap),
		tenantId,
		ownerPrincipalId,
	});
	return { service, realtime: new DebugConversationRealtime(service), capture: cap };
}

function eventTypes(events: readonly { eventType: string }[]): string[] {
	return events.map((e) => e.eventType);
}

describe("DebugConversationRuntimeAdapter (Phase 2, P0)", () => {
	it("A. streams assistant deltas and persists turn/end from ONE execution", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([{ revision: 1, model: MODEL_A }]);
		const { service, realtime, capture } = makeService(repos, publishing, TENANT_A, OWNER_A);
		const conv = await service.createNew(AGENT_ID);
		const adapter = await realtime.acquire(conv.debugConversationId);

		expect(adapter.snapshot().id).toBeTruthy();
		expect(adapter.snapshot().id.startsWith("dconv_")).toBe(true);

		const progress: PiSessionRuntimeEvent[] = [];
		adapter.subscribe((event) => progress.push(event));
		adapter.snapshot();
		await adapter.prompt({ text: "Hello Debug" });

		// Streaming deltas were re-keyed to the stable turn identity.
		const deltaMessageIds: string[] = [];
		for (const event of progress) {
			if (event.type === "progress" && event.progress.type === "assistant_delta") {
				deltaMessageIds.push(event.progress.messageId);
			}
		}
		expect(deltaMessageIds.length).toBe(2);
		for (const messageId of deltaMessageIds) expect(messageId).toMatch(/^ast:[0-9a-f-]+$/);

		// One inner prompt drove everything.
		expect(capture.prompts.length).toBe(1);

		// Final snapshot is idle with an assistant transcript item.
		const final = adapter.snapshot();
		expect(final.phase).toBe("idle");
		const assistant = final.transcript.find((item) => item.role === "assistant");
		expect(assistant).toBeTruthy();
		expect("text" in assistant!.content[0]! ? assistant!.content[0]!.text : "").toBe("echo:Hello Debug");

		// Same turnId across the persisted events; exactly one terminal.
		const events = await service.listEvents(conv.debugConversationId);
		const turnIds = new Set(events.map((e) => e.turnId));
		expect(turnIds.size).toBe(1);
		expect(eventTypes(events)).toEqual(["turn/start", "user/message", "assistant/message", "turn/end"]);
	});

	it("B. cancel persists a single turn/interrupted and the next turn still runs", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([{ revision: 1, model: MODEL_A }]);
		const { service, realtime, capture } = makeService(repos, publishing, TENANT_A, OWNER_A);
		const conv = await service.createNew(AGENT_ID);
		const adapter = await realtime.acquire(conv.debugConversationId);

		capture.blockOnPrompt = true;
		const promptPromise = adapter.prompt({ text: "slow turn" });
		// Let the turn start so the active-turn registry is populated, then abort.
		await new Promise((r) => setTimeout(r, 0));
		await adapter.abort();
		await promptPromise;

		// Single terminal: interrupted only, no end/failed.
		const events = await service.listEvents(conv.debugConversationId);
		expect(eventTypes(events)).toEqual(["turn/start", "user/message", "turn/interrupted"]);
		const terminals = events.filter((e) => ["turn/end", "turn/failed", "turn/interrupted"].includes(e.eventType));
		expect(terminals.length).toBe(1);
		expect(terminals[0]!.eventType).toBe("turn/interrupted");

		// The conversation survives the abort and a following Turn runs.
		capture.blockOnPrompt = false;
		await adapter.prompt({ text: "next turn" });
		const after = await service.listEvents(conv.debugConversationId);
		expect(eventTypes(after)).toContain("assistant/message");
		expect(eventTypes(after)).toContain("turn/end");
		const end = after.filter((e) => e.eventType === "turn/end");
		expect(end.length).toBe(1);
	});

	it("C. a revision change keeps the conversation identity, rebuilds the inner runtime, preserves history, streams", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([
			{ revision: 1, model: MODEL_A },
			{ revision: 2, model: MODEL_B },
		]);
		const { service, realtime, capture } = makeService(repos, publishing, TENANT_A, OWNER_A);
		const conv = await service.createNew(AGENT_ID);
		const adapter = await realtime.acquire(conv.debugConversationId);
		const identityBefore = adapter.id;
		const convIdBefore = conv.debugConversationId;

		await adapter.prompt({ text: "T1 rev17" });
		expect(capture.created).toBe(1);

		// Save a new revision; the conversation + adapter must not change.
		publishing.advanceRevision();
		await adapter.prompt({ text: "T2 rev18" });

		expect(adapter.id).toBe(identityBefore);
		expect(conv.debugConversationId).toBe(convIdBefore);
		// Inner runtime was rebuilt (new bottom session created).
		expect(capture.created).toBe(2);

		// History from the rev-1 turn is injected into the rev-2 prompt.
		const t2 = capture.prompts[1]!;
		expect((t2.retrieval?.context ?? "").includes("T1 rev17")).toBe(true);
		expect((t2.retrieval?.context ?? "").includes("echo:T1 rev17")).toBe(true);

		// Streaming still reaches the adapter after the rebuild.
		const final = adapter.snapshot();
		expect(final.transcript.filter((item) => item.role === "assistant").length).toBe(2);

		// Turn 2 /start carries the new revision; history intact in DB.
		const events = await service.listEvents(conv.debugConversationId);
		const t2Start = events.find(
			(e) => e.eventType === "turn/start" && (e.payload as { turnId?: string }).turnId !== events[0]!.turnId,
		);
		expect(t2Start).toBeTruthy();
	});

	it("D. reconnect / cache loss rebuilds the snapshot from events and continues", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([
			{ revision: 1, model: MODEL_A },
			{ revision: 2, model: MODEL_B },
		]);
		const { service, realtime } = makeService(repos, publishing, TENANT_A, OWNER_A);
		const conv = await service.createNew(AGENT_ID);
		const adapter = await realtime.acquire(conv.debugConversationId);
		await adapter.prompt({ text: "T1" });
		await adapter.prompt({ text: "T2" });

		// Simulate a fresh server instance: same persisted repos, brand-new
		// service + realtime (no runtime/adapter cache).
		const fresh = makeService(repos, publishing, TENANT_A, OWNER_A);
		const freshAdapter = await fresh.realtime.acquire(conv.debugConversationId);

		// History (user + assistant text) restored from the event stream.
		const transcript = freshAdapter.snapshot().transcript;
		const texts = transcript.flatMap((item) => item.content.map((part) => ("text" in part ? part.text : "")));
		expect(texts).toContain("T1");
		expect(texts).toContain("echo:T1");
		expect(texts).toContain("T2");
		expect(texts).toContain("echo:T2");

		// And the next Turn streams on the fresh instance (advance revision to
		// also exercise the rebuild-from-scratch path).
		publishing.advanceRevision();
		await freshAdapter.prompt({ text: "T3" });
		const afterTexts = freshAdapter
			.snapshot()
			.transcript.flatMap((item) => item.content.map((part) => ("text" in part ? part.text : "")));
		expect(afterTexts).toContain("echo:T3");
	});

	it("F. the realtime turnId is the single durable Turn identity across every persisted event", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([{ revision: 1, model: MODEL_A }]);
		const { service, realtime } = makeService(repos, publishing, TENANT_A, OWNER_A);
		const conv = await service.createNew(AGENT_ID);
		const adapter = await realtime.acquire(conv.debugConversationId);

		// LiveSessionManager calls beginTurn() before the prompt op and uses its
		// return as live.currentTurnId / session_progress.turnId.
		const realtimeTurnId = adapter.beginTurn();
		await adapter.prompt({ text: "unified turn id" });

		// Every persisted event of the Turn (turn/start, user/message,
		// assistant/message, turn/end) shares that same id — no second random set.
		const events = await service.listEvents(conv.debugConversationId);
		expect(events.length).toBeGreaterThan(0);
		for (const event of events) expect(event.turnId).toBe(realtimeTurnId);

		// The transcript item ids and the streaming keys cohere on the same id.
		const itemIds = adapter.snapshot().transcript.map((item) => item.id);
		expect(itemIds).toContain(`user:${realtimeTurnId}`);
		expect(itemIds).toContain(`ast:${realtimeTurnId}`);
	});

	it("G. only one active Turn per conversation: a concurrent prompt is rejected and cancel targets the same turnId", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([{ revision: 1, model: MODEL_A }]);
		const { service, realtime, capture } = makeService(repos, publishing, TENANT_A, OWNER_A);
		const conv = await service.createNew(AGENT_ID);
		const adapter = await realtime.acquire(conv.debugConversationId);

		capture.blockOnPrompt = true;
		const firstTurnId = adapter.beginTurn();
		const firstPrompt = adapter.prompt({ text: "slow turn" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		// LiveSessionManager path: the second prompt's beginTurn() rejects
		// atomically (single active-Turn slot) BEFORE any transcript mutation.
		expect(() => adapter.beginTurn()).toThrow(/already running another Turn/);

		// Direct-path fallback prompt is also rejected and does not pollute the
		// transcript with a second user item (it restores the pre-turn snapshot).
		await expect(adapter.prompt({ text: "second prompt" })).rejects.toThrow();
		const userItems = () => adapter.snapshot().transcript.filter((item) => item.role === "user").length;
		expect(userItems()).toBe(1);

		// Cancel targets the same active Turn id: the interrupted terminal event
		// carries the first turn's beginTurn id, and no end/failed is written.
		await adapter.abort();
		await firstPrompt;
		const events = await service.listEvents(conv.debugConversationId);
		const terminals = events.filter((e) => ["turn/end", "turn/failed", "turn/interrupted"].includes(e.eventType));
		expect(terminals.length).toBe(1);
		expect(terminals[0]!.eventType).toBe("turn/interrupted");
		expect(terminals[0]!.turnId).toBe(firstTurnId);
	});

	it("E. a different tenant cannot attach a conversation by guessing its id", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([{ revision: 1, model: MODEL_A }]);
		const { service, realtime } = makeService(repos, publishing, TENANT_A, OWNER_A);
		const conv = await service.createNew(AGENT_ID);

		// Attach within the owning tenant: OK.
		await expect(realtime.acquire(conv.debugConversationId)).resolves.toBeTruthy();

		// A different tenant sharing the same physical repos cannot resolve it.
		const { realtime: otherTenant } = makeService(repos, publishing, TENANT_B, OWNER_B);
		await expect(otherTenant.acquire(conv.debugConversationId)).rejects.toThrow();

		// A different owner within the same tenant cannot resolve it either.
		const { realtime: otherOwner } = makeService(repos, publishing, TENANT_A, OWNER_B);
		await expect(otherOwner.acquire(conv.debugConversationId)).rejects.toThrow();
	});

	it("P2B-A. thinking delta reaches the adapter subscriber (kind=thinking)", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([{ revision: 1, model: MODEL_A }]);
		const { service, realtime, capture } = makeService(repos, publishing, TENANT_A, OWNER_A);
		capture.emitThinking = true;
		const conv = await service.createNew(AGENT_ID);
		const adapter = await realtime.acquire(conv.debugConversationId);

		const progress: PiSessionRuntimeEvent[] = [];
		adapter.subscribe((event) => progress.push(event));
		await adapter.prompt({ text: "think" });

		const thinkingDeltas = progress.filter(
			(e) => e.type === "progress" && e.progress.type === "assistant_delta" && e.progress.kind === "thinking",
		);
		expect(thinkingDeltas.length).toBe(1);
		const delta = thinkingDeltas[0]!;
		if (delta.type === "progress") {
			expect(delta.progress.type === "assistant_delta" ? delta.progress.delta : "").toBe("considered");
			expect(delta.progress.type === "assistant_delta" ? delta.progress.messageId : "").toMatch(/^ast:/);
		}
	});

	it("P2B-B. complete final assistant item keeps the thinking part (no flicker)", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([{ revision: 1, model: MODEL_A }]);
		const { service, realtime, capture } = makeService(repos, publishing, TENANT_A, OWNER_A);
		capture.emitThinking = true;
		const conv = await service.createNew(AGENT_ID);
		const adapter = await realtime.acquire(conv.debugConversationId);

		await adapter.prompt({ text: "think" });
		const final = adapter.snapshot();
		const assistant = final.transcript.find((item) => item.role === "assistant");
		expect(assistant).toBeTruthy();
		expect(assistant!.content.some((c) => c.type === "thinking")).toBe(true);
		const thinking = assistant!.content.find((c) => c.type === "thinking");
		expect(thinking?.type === "thinking" ? thinking.thinking : "").toBe("considered");
	});

	it("P2B-E. abort during thinking keeps streamed content, persists ONE turn/interrupted (no end/failed)", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([{ revision: 1, model: MODEL_A }]);
		const { service, realtime, capture } = makeService(repos, publishing, TENANT_A, OWNER_A);
		capture.emitThinking = true;
		capture.blockOnPrompt = true;
		const conv = await service.createNew(AGENT_ID);
		const adapter = await realtime.acquire(conv.debugConversationId);

		const promptPromise = adapter.prompt({ text: "slow think" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		await adapter.abort();
		await promptPromise;

		// The final snapshot keeps the already-streamed thinking + text.
		const final = adapter.snapshot();
		const assistant = final.transcript.find((item) => item.role === "assistant");
		expect(assistant?.status).toBe("aborted");
		expect(assistant?.content.some((c) => c.type === "thinking")).toBe(true);
		expect(assistant?.content.some((c) => c.type === "text")).toBe(true);

		// turn/interrupted is the single terminal; no assistant/message + turn/end.
		const events = await service.listEvents(conv.debugConversationId);
		expect(events.map((e) => e.eventType)).toEqual(["turn/start", "user/message", "turn/interrupted"]);
		const terminals = events.filter((e) => ["turn/end", "turn/failed", "turn/interrupted"].includes(e.eventType));
		expect(terminals.length).toBe(1);
		expect(terminals[0]!.eventType).toBe("turn/interrupted");
	});

	it("P2B-F. next Turn after abort streams normally", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([{ revision: 1, model: MODEL_A }]);
		const { service, realtime, capture } = makeService(repos, publishing, TENANT_A, OWNER_A);
		capture.emitThinking = true;
		capture.blockOnPrompt = true;
		const conv = await service.createNew(AGENT_ID);
		const adapter = await realtime.acquire(conv.debugConversationId);

		const promptPromise = adapter.prompt({ text: "slow" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		await adapter.abort();
		await promptPromise;

		capture.blockOnPrompt = false;
		await adapter.prompt({ text: "next" });
		const events = await service.listEvents(conv.debugConversationId);
		expect(events.filter((e) => e.eventType === "turn/end").length).toBe(1);
		expect(events.filter((e) => e.eventType === "turn/interrupted").length).toBe(1);
	});

	it("P2B-H. revision/model change: new Turn uses the new effective thinkingLevel, turn/start records it", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([
			{ revision: 17, model: MODEL_A, params: { reasoning: { enabled: true, effort: "high" } } },
			{ revision: 18, model: MODEL_B, params: { reasoning: { enabled: false } } },
		]);
		const { service, realtime, capture } = makeService(repos, publishing, TENANT_A, OWNER_A);
		const conv = await service.createNew(AGENT_ID);
		const adapter = await realtime.acquire(conv.debugConversationId);

		await adapter.prompt({ text: "T1 rev17" });
		expect(capture.created).toBe(1);
		publishing.advanceRevision();
		await adapter.prompt({ text: "T2 rev18" });
		// Inner runtime rebuilt on revision change.
		expect(capture.created).toBe(2);

		const events = await service.listEvents(conv.debugConversationId);
		const turnStarts = events.filter((e) => e.eventType === "turn/start");
		expect(turnStarts.length).toBe(2);
		const first = turnStarts[0]!.payload as { thinkingLevel?: string };
		const second = turnStarts[1]!.payload as { thinkingLevel?: string };
		expect(first.thinkingLevel).toBe("high");
		expect(second.thinkingLevel).toBe("off");
	});

	it("P2C-A. attachmentIds forwarded from Composer through adapter.prompt to the inner runtime.prompt input", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([{ revision: 1, model: MODEL_A }]);
		const { service, realtime, capture } = makeService(repos, publishing, TENANT_A, OWNER_A);
		const conv = await service.createNew(AGENT_ID);
		const adapter = await realtime.acquire(conv.debugConversationId);

		await adapter.prompt({ text: "with file", attachmentIds: ["upload-A"] });
		expect(capture.prompts.length).toBe(1);
		expect(capture.prompts[0]?.attachmentIds).toEqual(["upload-A"]);
	});

	it("P2C-E1. turn with attachmentIds passes them to the inner runtime", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([{ revision: 1, model: MODEL_A }]);
		const { service, realtime, capture } = makeService(repos, publishing, TENANT_A, OWNER_A);
		const conv = await service.createNew(AGENT_ID);
		const adapter = await realtime.acquire(conv.debugConversationId);

		await adapter.prompt({ text: "T1", attachmentIds: ["upload-A"] });
		expect(capture.prompts[0]?.attachmentIds).toEqual(["upload-A"]);
	});

	it("P2C-E2. turn with empty attachmentIds does NOT auto-include prior attachments", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([{ revision: 1, model: MODEL_A }]);
		const { service, realtime, capture } = makeService(repos, publishing, TENANT_A, OWNER_A);
		const conv = await service.createNew(AGENT_ID);
		const adapter = await realtime.acquire(conv.debugConversationId);

		await adapter.prompt({ text: "T1", attachmentIds: ["upload-A"] });
		await adapter.prompt({ text: "T2" });
		expect(capture.prompts[1]?.attachmentIds).toBeUndefined();
	});

	it("P2C-E3. turn can opt back into a prior attachment by listing its id again", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([{ revision: 1, model: MODEL_A }]);
		const { service, realtime, capture } = makeService(repos, publishing, TENANT_A, OWNER_A);
		const conv = await service.createNew(AGENT_ID);
		const adapter = await realtime.acquire(conv.debugConversationId);

		await adapter.prompt({ text: "T1", attachmentIds: ["upload-A"] });
		await adapter.prompt({ text: "T2" });
		await adapter.prompt({ text: "T3", attachmentIds: ["upload-A"] });
		expect(capture.prompts[2]?.attachmentIds).toEqual(["upload-A"]);
	});

	it("P2C-F. persistAttachmentEvent writes attachment_snapshot and attachment_removed to the event stream", async () => {
		const repos = makeDebugRepos();
		const publishing = makePublishing([{ revision: 1, model: MODEL_A }]);
		const { service } = makeService(repos, publishing, TENANT_A, OWNER_A);
		const conv = await service.createNew(AGENT_ID);

		const snapshot = {
			id: "upload-A",
			name: "notes.txt",
			mediaType: "text/plain",
			size: 12,
			sha256: "0".repeat(64),
			status: "ready" as const,
			scope: "session" as const,
			createdAt: Date.now(),
		};
		await service.persistAttachmentEvent(conv.debugConversationId, "attachment_snapshot", snapshot);
		await service.persistAttachmentEvent(conv.debugConversationId, "attachment_removed", {
			sessionId: conv.debugConversationId,
			attachmentId: "upload-A",
		});

		const events = await service.listEvents(conv.debugConversationId);
		const types = events.map((e) => e.eventType);
		expect(types).toContain("attachment_snapshot");
		expect(types).toContain("attachment_removed");

		const snapEvent = events.find((e) => e.eventType === "attachment_snapshot");
		expect(snapEvent?.payload).toMatchObject({ id: "upload-A", name: "notes.txt" });
	});
});
