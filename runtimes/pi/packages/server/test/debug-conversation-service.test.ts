/**
 * Debug Conversation Phase 1 unit tests (in-memory fakes, no Postgres).
 *
 * Verifies the end-to-end vertical slice:
 *  - lazy create + resume by (owner, agent)
 *  - per-Turn revision resolve + spec compile
 *  - Runtime cache reuse on identical spec / rebuild on spec change
 *  - history carryover across a revision change (user + assistant text only)
 *  - Turn event persistence (turn/start with actualPublishedAppVersionId=null)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, Citation } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import { attachmentStoreReader, CitationService, conversationRetrievalEnabled } from "../src/citations/service.ts";
import { CitationStore } from "../src/citations/store.ts";
import { DebugConversationRealtime } from "../src/publishing/debug/realtime.ts";
import { DebugConversationService } from "../src/publishing/debug/service.ts";
import type {
	DebugConversationEventInput,
	DebugConversationEventRecord,
	DebugConversationRecord,
	DebugRepositories,
} from "../src/publishing/debug/types.ts";
import {
	type AgentDefinitionId,
	fromPublicId,
	newAgentDefinitionId,
	newTurnId,
	type PrincipalId,
	type TenantId,
	toPublicId,
} from "../src/publishing/domain/ids.ts";
import type { PublishingRepositories } from "../src/publishing/repositories.ts";
import type { CapabilityCatalog } from "../src/publishing/runtime-spec/compiler.ts";
import type { PiSessionRuntime, PromptInput } from "../src/types.ts";
import { AttachmentStore } from "../src/uploads/store.ts";

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

const AGENT_ID = (fromPublicId("AgentDefinitionId", `agent_${newAgentDefinitionId()}`) ??
	newAgentDefinitionId()) as AgentDefinitionId;

interface Capture {
	prompts: PromptInput[];
	created: number;
}

function createFakeDebugRepos(): DebugRepositories {
	const byId = new Map<string, DebugConversationRecord>();
	const eventsByConv = new Map<string, DebugConversationEventRecord[]>();
	const eventCounters = new Map<string, number>();
	// Monotonically-advancing clock so the Phase 2E History list test can
	// distinguish per-event `lastActiveAt` ticks on fast machines where
	// `Date.now()` would otherwise return the same millisecond for the
	// entire turn. Each `append` (and each `createNew`) advances this by
	// 1ms; the assertion in the test is "newest first", not "real time".
	let tick = 0;
	const nextTick = (): Date => {
		tick += 1;
		return new Date(Date.now() + tick);
	};
	return {
		conversations: {
			async insert(record: DebugConversationRecord) {
				byId.set(record.debugConversationId, record);
				eventCounters.set(record.debugConversationId, 0);
				// Stagger the `lastActiveAt` so the History-list ordering test
				// can distinguish "older" from "newer" without depending on
				// wall-clock millisecond precision.
				(record as { lastActiveAt: Date }).lastActiveAt = nextTick();
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
				return byId.get(scope.debugConversationId);
			},
			async setStatus(scope, status) {
				const rec = byId.get(scope.debugConversationId);
				if (rec === undefined || rec.status !== "active") return false;
				rec.status = status;
				return true;
			},
			// Phase 2E in-memory mirror of the PG LATERAL preview join. Orders
			// by `lastActiveAt DESC, id DESC` and returns the first
			// `user/message` payload's `text` field as the preview.
			async listByScope(params) {
				const limit = Math.min(Math.max(params.limit, 1), 100);
				const all = [...byId.values()].filter(
					(rec) =>
						rec.tenantId === params.tenantId &&
						rec.ownerPrincipalId === params.ownerPrincipalId &&
						rec.agentId === params.agentId &&
						rec.status === "active",
				);
				all.sort((a, b) => {
					if (a.lastActiveAt > b.lastActiveAt) return -1;
					if (a.lastActiveAt < b.lastActiveAt) return 1;
					return a.debugConversationId < b.debugConversationId ? -1 : 1;
				});
				const sliced = all.slice(0, limit);
				return sliced.map((conversation) => {
					const events = eventsByConv.get(conversation.debugConversationId) ?? [];
					const firstUser = events.find((e) => e.eventType === "user/message");
					const payload = firstUser?.payload as { text?: unknown } | undefined;
					const text = typeof payload?.text === "string" ? payload.text : null;
					return {
						conversation,
						firstUserMessagePreview: text !== null && text.length > 0 ? text : null,
					};
				});
			},
			// Phase 2F in-memory mirror of the PG conditional-UPDATE expire: only
			// `active` conversations older than `cutoff` are soft-deleted.
			async expireActiveBefore(scope, cutoff) {
				const expired: Array<DebugConversationRecord["debugConversationId"]> = [];
				for (const rec of byId.values()) {
					if (
						rec.tenantId === scope.tenantId &&
						rec.ownerPrincipalId === scope.ownerPrincipalId &&
						rec.status === "active" &&
						rec.lastActiveAt < cutoff
					) {
						(rec as { status: DebugConversationRecord["status"] }).status = "deleted";
						(rec as { deletedAt: Date | null }).deletedAt = new Date();
						expired.push(rec.debugConversationId);
					}
				}
				return expired;
			},
			async listDeletedBefore(scope, cutoff) {
				return [...byId.values()].filter(
					(rec) =>
						rec.tenantId === scope.tenantId &&
						rec.ownerPrincipalId === scope.ownerPrincipalId &&
						rec.status === "deleted" &&
						rec.deletedAt !== null &&
						rec.deletedAt < cutoff,
				);
			},
			async deletePhysical(scope, conversationId) {
				eventsByConv.delete(conversationId);
				return byId.delete(conversationId);
			},
		},
		events: {
			async append(_scope, conversationId, input: DebugConversationEventInput) {
				// Phase 2F: mirror PG's atomic `status='active'` guard on the
				// conditional UPDATE — a soft-deleted conversation can no longer
				// append (so a Turn on it is rejected at persistence time).
				const guard = byId.get(conversationId);
				if (guard !== undefined && guard.status !== "active") return undefined;
				if (!eventCounters.has(conversationId)) eventCounters.set(conversationId, 0);
				const next = (eventCounters.get(conversationId) ?? 0) + 1;
				eventCounters.set(conversationId, next);
				// Mirror the PG atomic-sequence machine: every event append
				// bumps `last_event_sequence` AND `last_active_at` on the
				// conversation row. The Phase 2E History list sorts by
				// `lastActiveAt DESC`, so the fake must surface a real,
				// monotonically-advancing timestamp or the ordering test
				// cannot tell c from a.
				const record = byId.get(conversationId);
				if (record !== undefined) {
					(record as { lastEventSequence: number; lastActiveAt: Date }).lastEventSequence = next;
					// Monotonic clock: each `append` advances the fake's
					// internal tick so the History list can order turns
					// deterministically even when the test wall clock has
					// not moved between events.
					(record as { lastEventSequence: number; lastActiveAt: Date }).lastActiveAt = nextTick();
				}
				const event: DebugConversationEventRecord = {
					eventId: `devt_${next}` as DebugConversationEventRecord["eventId"],
					debugConversationId: conversationId,
					sequence: next,
					eventType: input.eventType,
					eventSchemaVersion: input.eventSchemaVersion ?? 1,
					turnId: input.turnId ?? null,
					payload: input.payload,
					createdAt: new Date(),
				};
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

interface Harness {
	service: DebugConversationService;
	capture: Capture;
	repos: DebugRepositories;
	advanceRevision(): void;
	nextTurnId(): ReturnType<typeof newTurnId>;
}

function makeHarness(
	revisions: Array<{
		revision: number;
		model: { provider: string; modelId: string };
		params?: { reasoning?: { enabled?: boolean; effort?: string } };
	}>,
	opts?: { readonly openError?: string; readonly promptError?: string },
): Harness {
	let cursor = 0;
	const capture: Capture = { prompts: [], created: 0 };
	const repos = createFakeDebugRepos();
	const publishingRepos = {
		agentDefinitions: {
			getLatest: async () => revisionRecord(revisions[cursor]!),
		},
		skills: {
			listBindings: async () => [],
			get: async () => undefined,
			getRevision: async () => undefined,
		},
		mcpServers: {
			listBindings: async () => [],
			get: async () => undefined,
			getRevision: async () => undefined,
			listTools: async () => [],
		},
	} as unknown as PublishingRepositories;

	const service = new DebugConversationService({
		repositories: publishingRepos,
		debug: repos,
		catalog: CATALOG,
		createSession: (sessionOpts) => {
			if (opts?.openError !== undefined) throw new Error(opts.openError);
			capture.created += 1;
			return fakeSession(capture, opts?.promptError)(sessionOpts);
		},
		tenantId: TENANT_ID,
		ownerPrincipalId: OWNER,
	});

	return {
		service,
		capture,
		repos,
		advanceRevision: () => {
			cursor += 1;
		},
		nextTurnId: () => newTurnId(),
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

function fakeSession(capture: Capture, promptError?: string): (opts: unknown) => PiSessionRuntime {
	return (opts: unknown) => {
		const items: Array<Record<string, unknown>> = [];
		const session: PiSessionRuntime = {
			ephemeral: true,
			snapshot: () =>
				({ id: (opts as { id: string }).id, transcript: items }) as unknown as ReturnType<
					PiSessionRuntime["snapshot"]
				>,
			getPhase: () => "idle" as never,
			async prompt(input: PromptInput) {
				capture.prompts.push(input);
				if (promptError !== undefined) throw new Error(promptError);
				items.push({
					role: "assistant",
					status: "complete",
					content: [
						{ type: "text", text: `echo:${input.text}` },
						{ type: "thinking", redacted: false, thinking: "considered" },
					],
				});
			},
			async steer() {},
			async abort() {},
			async setModel() {},
			async setThinking() {},
			subscribe: () => () => {},
			async dispose() {},
		};
		return session;
	};
}

describe("DebugConversationService (Phase 1)", () => {
	it("lazy-creates, runs a turn, persists events, and resumes the recent active conversation", async () => {
		const { service, nextTurnId } = makeHarness([{ revision: 1, model: MODEL_A }]);

		expect(await service.resume(AGENT_ID)).toBeUndefined();

		const conv = await service.createNew(AGENT_ID);
		const result = await service.executeTurn(conv.debugConversationId, "hello", nextTurnId());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.outputText).toBe("echo:hello");

		expect((await service.resume(AGENT_ID))?.debugConversationId).toBe(conv.debugConversationId);

		const events = await service.listEvents(conv.debugConversationId);
		const types = events.map((e) => e.eventType);
		expect(types).toEqual(expect.arrayContaining(["turn/start", "user/message", "assistant/message", "turn/end"]));
		const turnStart = events.find((e) => e.eventType === "turn/start");
		expect((turnStart?.payload as { actualPublishedAppVersionId: unknown }).actualPublishedAppVersionId).toBeNull();
		expect((turnStart?.payload as { resolutionSource: unknown }).resolutionSource).toBe("followLatest");
	});

	it("rebuilds the Runtime per headless Turn (release-after-2F) and carries history on a revision change", async () => {
		const { service, capture, advanceRevision, nextTurnId } = makeHarness([
			{ revision: 1, model: MODEL_A },
			{ revision: 2, model: MODEL_B },
		]);

		const conv = await service.createNew(AGENT_ID);

		// Phase 2F: the headless path releases its Runtime after each Turn, so a
		// fresh session is created per Turn. Continuity is NOT lost — history is
		// rebuilt from the DB event stream via `restoreContext` on every Turn.
		// Turn 1 @ rev 1
		const t1 = await service.executeTurn(conv.debugConversationId, "TurnOne", nextTurnId());
		expect(t1.ok).toBe(true);
		expect(capture.created).toBe(1);

		// Turn 2 @ same revision, runtime released after Turn 1: rebuilt, but the
		// rev-1 history is still injected from events.
		const t2 = await service.executeTurn(conv.debugConversationId, "TurnTwo", nextTurnId());
		expect(t2.ok).toBe(true);
		expect(capture.created).toBe(2);
		const turn2Prompt = capture.prompts[1]!;
		expect(turn2Prompt.text).toBe("TurnTwo");
		expect(turn2Prompt.retrieval?.context).toContain("TurnOne");
		expect(turn2Prompt.retrieval?.context).toContain("echo:TurnOne");

		// Revision change: next Turn rebuilds the Runtime (already fresh) and
		// keeps THIS conversation.
		advanceRevision();
		const t3 = await service.executeTurn(conv.debugConversationId, "TurnThree", nextTurnId());
		expect(t3.ok).toBe(true);
		expect(capture.created).toBe(3);
		const turn3Prompt = capture.prompts[2]!;
		expect(turn3Prompt.text).toBe("TurnThree");
		// History from rev-1 turns is still injected (user + assistant text only).
		expect(turn3Prompt.retrieval?.context).toContain("TurnOne");
		expect(turn3Prompt.retrieval?.context).toContain("echo:TurnOne");
		expect(turn3Prompt.retrieval?.context).toContain("TurnTwo");
		expect(turn3Prompt.retrieval?.context).toContain("echo:TurnTwo");
		// No tool/reasoning recovery.
		expect(turn3Prompt.retrieval?.context).not.toContain("tool/");
	});

	it("persists turn/start + user/message BEFORE execution and turn/failed (same turnId, no turn/end) when the model throws", async () => {
		const { service, nextTurnId } = makeHarness([{ revision: 1, model: MODEL_A }], {
			promptError: "model exploded",
		});
		const conv = await service.createNew(AGENT_ID);

		const result = await service.executeTurn(conv.debugConversationId, "risky", nextTurnId());
		expect(result.ok).toBe(false);

		const events = await service.listEvents(conv.debugConversationId);
		// turn/start + user/message must exist even though execution failed.
		expect(events.map((e) => e.eventType)).toEqual(["turn/start", "user/message", "turn/failed"]);
		const [start, user, failed] = events;
		for (const event of events) expect(event.turnId).toBe(start!.turnId);
		expect(failed?.payload as { error: string }).toMatchObject({ error: expect.stringContaining("model exploded") });
		// Sequences are strictly increasing: start < user < failed.
		expect(start!.sequence).toBeLessThan(user!.sequence);
		expect(user!.sequence).toBeLessThan(failed!.sequence);
	});

	it("persists turn/start + user/message + turn/failed when the Runtime cannot be opened", async () => {
		const { service, nextTurnId } = makeHarness([{ revision: 1, model: MODEL_A }], {
			openError: "session open failed",
		});
		const conv = await service.createNew(AGENT_ID);

		const result = await service.executeTurn(conv.debugConversationId, "hello", nextTurnId());
		expect(result.ok).toBe(false);

		const events = await service.listEvents(conv.debugConversationId);
		expect(events.map((e) => e.eventType)).toEqual(["turn/start", "user/message", "turn/failed"]);
		const failed = events.at(-1)!;
		expect(failed.turnId).toBe(events[0]!.turnId);
		expect(failed.payload as { error: string }).toMatchObject({
			error: expect.stringContaining("session open failed"),
		});
	});

	it("P2B-C. assistant/message persists final thinking; no per-delta reasoning events", async () => {
		const { service, nextTurnId } = makeHarness([
			{ revision: 1, model: MODEL_A, params: { reasoning: { enabled: true, effort: "high" } } },
		]);
		const conv = await service.createNew(AGENT_ID);

		const result = await service.executeTurn(conv.debugConversationId, "hello", nextTurnId());
		expect(result.ok).toBe(true);
		expect((result as { thinkingText?: string }).thinkingText).toBe("considered");

		const events = await service.listEvents(conv.debugConversationId);
		const types = events.map((e) => e.eventType);
		// Single assistant/message terminal; NO per-delta reasoning events.
		expect(types).toEqual(["turn/start", "user/message", "assistant/message", "turn/end"]);
		expect(types.filter((t) => t.includes("reason") || t.includes("thinking"))).toEqual([]);

		const assistant = events.find((e) => e.eventType === "assistant/message");
		const payload = assistant!.payload as { text: string; thinking?: string };
		expect(payload.text).toBe("echo:hello");
		expect(payload.thinking).toBe("considered");

		// turn/start records the effective thinkingLevel (explicit effort).
		const turnStart = events.find((e) => e.eventType === "turn/start");
		expect((turnStart!.payload as { thinkingLevel?: string }).thinkingLevel).toBe("high");
	});

	it("P2B-G. capability defaultEffort applies when the Agent does not configure reasoning", async () => {
		// No params.reasoning on the revision: the model capability default
		// (defaultEffort "medium") must win — same rule as Production.
		const { service, nextTurnId } = makeHarness([{ revision: 1, model: MODEL_A }]);
		const conv = await service.createNew(AGENT_ID);

		const result = await service.executeTurn(conv.debugConversationId, "hello", nextTurnId());
		expect(result.ok).toBe(true);

		const events = await service.listEvents(conv.debugConversationId);
		const turnStart = events.find((e) => e.eventType === "turn/start");
		expect((turnStart!.payload as { thinkingLevel?: string }).thinkingLevel).toBe("medium");
	});

	it("P2B-G2. explicit reasoning.enabled=false wins over capability defaultEffort", async () => {
		const { service, nextTurnId } = makeHarness([
			{ revision: 1, model: MODEL_A, params: { reasoning: { enabled: false } } },
		]);
		const conv = await service.createNew(AGENT_ID);

		const result = await service.executeTurn(conv.debugConversationId, "hello", nextTurnId());
		expect(result.ok).toBe(true);

		const events = await service.listEvents(conv.debugConversationId);
		const turnStart = events.find((e) => e.eventType === "turn/start");
		expect((turnStart!.payload as { thinkingLevel?: string }).thinkingLevel).toBe("off");
	});

	it("P2C-C. persistAttachmentEvent rebuilds attachments via DebugConversationRealtime.acquire snapshot", async () => {
		const { service } = makeHarness([{ revision: 1, model: MODEL_A }]);
		const conv = await service.createNew(AGENT_ID);

		const attachment = {
			id: "upload-A",
			name: "notes.txt",
			mediaType: "text/plain",
			size: 12,
			sha256: "0".repeat(64),
			status: "ready" as const,
			scope: "session" as const,
			createdAt: Date.now(),
		};
		await service.persistAttachmentEvent(conv.debugConversationId, "attachment_snapshot", attachment);

		const realtime = new DebugConversationRealtime(service);
		const adapter = await realtime.acquire(conv.debugConversationId);
		const snapshot = adapter.snapshot();
		expect(snapshot.attachments?.length).toBe(1);
		expect(snapshot.attachments?.[0]?.id).toBe("upload-A");
		expect(snapshot.attachments?.[0]?.name).toBe("notes.txt");
	});

	it("P2C-F-removed. attachment_removed evicts the attachment from subsequent snapshots", async () => {
		const { service } = makeHarness([{ revision: 1, model: MODEL_A }]);
		const conv = await service.createNew(AGENT_ID);

		const attachment = {
			id: "upload-A",
			name: "notes.txt",
			mediaType: "text/plain",
			size: 12,
			sha256: "0".repeat(64),
			status: "ready" as const,
			scope: "session" as const,
			createdAt: Date.now(),
		};
		await service.persistAttachmentEvent(conv.debugConversationId, "attachment_snapshot", attachment);
		await service.persistAttachmentEvent(conv.debugConversationId, "attachment_removed", {
			sessionId: conv.debugConversationId,
			attachmentId: "upload-A",
		});

		const realtime = new DebugConversationRealtime(service);
		const adapter = await realtime.acquire(conv.debugConversationId);
		const snapshot = adapter.snapshot();
		expect(snapshot.attachments?.length ?? 0).toBe(0);
	});

	it("P2C-D. revision/runtime rebuild: attachment events survive the conversation id", async () => {
		const { service, advanceRevision } = makeHarness([
			{ revision: 17, model: MODEL_A, params: { reasoning: { enabled: true, effort: "high" } } },
			{ revision: 18, model: MODEL_B, params: { reasoning: { enabled: false } } },
		]);
		const conv = await service.createNew(AGENT_ID);

		const attachment = {
			id: "upload-A",
			name: "shared.txt",
			mediaType: "text/plain",
			size: 5,
			sha256: "f".repeat(64),
			status: "ready" as const,
			scope: "session" as const,
			createdAt: Date.now(),
		};
		await service.persistAttachmentEvent(conv.debugConversationId, "attachment_snapshot", attachment);

		// Snapshot before revision bump: attachment present.
		let realtime = new DebugConversationRealtime(service);
		let adapter = await realtime.acquire(conv.debugConversationId);
		expect(adapter.snapshot().attachments?.[0]?.id).toBe("upload-A");

		// Save rev18; inner runtime rebuilds; the conversation identity is stable.
		advanceRevision();

		// Drop the in-process adapter cache to simulate the rebuild path: a
		// fresh acquisition must rebuild attachments from the event stream.
		realtime = new DebugConversationRealtime(service);
		adapter = await realtime.acquire(conv.debugConversationId);
		// Same conversation id (public form), same attachment after rebuild.
		expect(adapter.snapshot().id).toBe(toPublicId("DebugConversationId", conv.debugConversationId));
		expect(adapter.snapshot().attachments?.[0]?.id).toBe("upload-A");
	});
});

interface RetrievalHarness {
	service: DebugConversationService;
	capture: Capture;
	attachments: AttachmentStore;
	citations: CitationService;
}

async function makeRetrievalHarness(): Promise<RetrievalHarness> {
	const dir = mkdtempSync(join(tmpdir(), "pi-debug-retrieval-"));
	const attachments = new AttachmentStore(join(dir, "uploads"));
	await attachments.init();
	const citationStore = new CitationStore(join(dir, "citations"));
	await citationStore.init();
	const citations = new CitationService({ store: citationStore, readContent: attachmentStoreReader(attachments) });
	const capture: Capture = { prompts: [], created: 0 };
	const publishingRepos = {
		agentDefinitions: { getLatest: async () => revisionRecord({ revision: 1, model: MODEL_A }) },
		skills: { listBindings: async () => [], get: async () => undefined, getRevision: async () => undefined },
		mcpServers: {
			listBindings: async () => [],
			get: async () => undefined,
			getRevision: async () => undefined,
			listTools: async () => [],
		},
	} as unknown as PublishingRepositories;
	const service = new DebugConversationService({
		repositories: publishingRepos,
		debug: createFakeDebugRepos(),
		catalog: CATALOG,
		createSession: async (sessionOpts) => {
			capture.created += 1;
			return fakeSession(capture)(sessionOpts);
		},
		tenantId: TENANT_ID,
		ownerPrincipalId: OWNER,
		citations,
	});
	return { service, capture, attachments, citations };
}

/** Like makeRetrievalHarness but also injects the AttachmentStore for GC cleanup. */
async function makeLifecycleHarness(): Promise<RetrievalHarness> {
	const dir = mkdtempSync(join(tmpdir(), "pi-debug-lifecycle-"));
	const attachments = new AttachmentStore(join(dir, "uploads"));
	await attachments.init();
	const citationStore = new CitationStore(join(dir, "citations"));
	await citationStore.init();
	const citations = new CitationService({ store: citationStore, readContent: attachmentStoreReader(attachments) });
	const capture: Capture = { prompts: [], created: 0 };
	const publishingRepos = {
		agentDefinitions: { getLatest: async () => revisionRecord({ revision: 1, model: MODEL_A }) },
		skills: { listBindings: async () => [], get: async () => undefined, getRevision: async () => undefined },
		mcpServers: {
			listBindings: async () => [],
			get: async () => undefined,
			getRevision: async () => undefined,
			listTools: async () => [],
		},
	} as unknown as PublishingRepositories;
	const service = new DebugConversationService({
		repositories: publishingRepos,
		debug: createFakeDebugRepos(),
		catalog: CATALOG,
		createSession: async (sessionOpts) => {
			capture.created += 1;
			return fakeSession(capture)(sessionOpts);
		},
		tenantId: TENANT_ID,
		ownerPrincipalId: OWNER,
		citations,
		attachments,
	});
	return { service, capture, attachments, citations };
}

/** Stage + adopt a text attachment already session-bound and index its Source. */
async function seedSource(
	harness: RetrievalHarness,
	publicConversationId: string,
	id: string,
	name: string,
	content: string,
): Promise<Attachment> {
	mkdirSync(join(harness.attachments.root, id), { recursive: true });
	const staged = join(harness.attachments.root, id, "file.txt");
	writeFileSync(staged, content, "utf-8");
	const attachment: Attachment = {
		id,
		sessionId: publicConversationId,
		name,
		mediaType: "text/plain",
		size: content.length,
		sha256: "abc",
		status: "ready",
		createdAt: Date.now(),
	};
	await harness.attachments.adopt(attachment, staged);
	await harness.citations.ensureSource(attachment);
	return attachment;
}

describe("DebugConversationService retrieval (Phase 2D read path)", () => {
	it("indexes an attached text Source under the dconv session and retrieves it into the model Turn", async () => {
		const harness = await makeRetrievalHarness();
		const conv = await harness.service.createNew(AGENT_ID);
		const publicId = toPublicId("DebugConversationId", conv.debugConversationId);
		await seedSource(
			harness,
			publicId,
			"att-shared",
			"guide.txt",
			"The deployment registration code is BANANA42 and must stay secret.",
		);

		// Source lives under the dconv public session id (reset-provable via store).
		expect(harness.citations.listSourcesBySession(publicId).some((s) => s.status === "ready")).toBe(true);

		const t1 = await harness.service.executeTurn(
			conv.debugConversationId,
			"what is the registration code?",
			newTurnId(),
		);
		expect(t1.ok).toBe(true);
		const prompt = harness.capture.prompts.at(-1)!;
		expect(prompt.retrieval?.citations.length ?? 0).toBeGreaterThan(0);
		expect(prompt.retrieval?.context).toContain("BANANA42");
		expect(prompt.retrieval?.reference).toContain("guide.txt");
		expect(
			(await harness.service.listEvents(conv.debugConversationId)).some(
				(event) => event.eventType === "citation/updated" && event.turnId === (t1.ok ? t1.turnId : undefined),
			),
		).toBe(true);
	});

	it("retrieves conversation Sources even when the Turn carries no attachmentIds", async () => {
		const harness = await makeRetrievalHarness();
		const conv = await harness.service.createNew(AGENT_ID);
		const publicId = toPublicId("DebugConversationId", conv.debugConversationId);
		await seedSource(harness, publicId, "att-shared2", "keys.txt", "The vault key is TWILIGHT-77.");
		await harness.service.executeTurn(conv.debugConversationId, "what is the vault key?", newTurnId());
		const t2 = await harness.service.executeTurn(conv.debugConversationId, "what is the vault key?", newTurnId(), {
			attachmentIds: [],
		});
		expect(t2.ok).toBe(true);
		expect(harness.capture.prompts.at(-1)!.retrieval?.citations.length ?? 0).toBeGreaterThan(0);
	});

	it("stops retrieving an attachment's Source once removed", async () => {
		const harness = await makeRetrievalHarness();
		const conv = await harness.service.createNew(AGENT_ID);
		const publicId = toPublicId("DebugConversationId", conv.debugConversationId);
		const attachment = await seedSource(harness, publicId, "att-gone", "old.txt", "The old token is DEPRECATED-9.");
		await harness.service.executeTurn(conv.debugConversationId, "what is the token?", newTurnId());
		expect(harness.capture.prompts.at(-1)!.retrieval?.citations.length ?? 0).toBeGreaterThan(0);
		await harness.citations.markSourceRemoved(attachment.id);
		const t2 = await harness.service.executeTurn(conv.debugConversationId, "what is the token?", newTurnId());
		expect(t2.ok).toBe(true);
		// Removed Source => no citation reaches the model (history context is still wrapped, but citations are empty).
		expect(harness.capture.prompts.at(-1)!.retrieval?.citations.length ?? 0).toBe(0);
	});

	it("never retrieves another conversation's Sources (cross-dconv isolation)", async () => {
		const harness = await makeRetrievalHarness();
		const conv = await harness.service.createNew(AGENT_ID);
		const other = await harness.service.createNew(AGENT_ID);
		await seedSource(
			harness,
			toPublicId("DebugConversationId", other.debugConversationId),
			"att-other",
			"private.txt",
			"The boss password is PRIVATE-42.",
		);
		const t1 = await harness.service.executeTurn(conv.debugConversationId, "what is the boss password?", newTurnId());
		expect(t1.ok).toBe(true);
		expect(harness.capture.prompts.at(-1)!.retrieval).toBeUndefined();
	});

	it("respects the production retrieval gap: uploads capability disabled => no retrieval", async () => {
		expect(conversationRetrievalEnabled({ capabilities: { uploads: { enabled: true } } } as never)).toBe(true);
		expect(conversationRetrievalEnabled({ capabilities: { uploads: { enabled: false } } } as never)).toBe(false);
	});

	it("executes a realtime Turn carrying citations so the adapter can emit citation_snapshot", async () => {
		const harness = await makeRetrievalHarness();
		const conv = await harness.service.createNew(AGENT_ID);
		const publicId = toPublicId("DebugConversationId", conv.debugConversationId);
		await seedSource(
			harness,
			publicId,
			"att-rt",
			"guide.txt",
			"The registration code is BANANA42 and must stay secret.",
		);
		await harness.service.beginTurn(conv.debugConversationId);
		const result = await harness.service.executeTurnRealtime(conv.debugConversationId, "registration code?", {
			inputTurnId: newTurnId(),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.citations?.length ?? 0).toBeGreaterThan(0);
		expect((result.citations ?? []).some((citation) => citation.title === "guide.txt")).toBe(true);
	});
});

describe("DebugConversationService.listHistory (Phase 2E)", () => {
	it("returns active conversations ordered by most recent activity, with the first user message preview joined in one round trip", async () => {
		const { service, nextTurnId } = makeHarness([{ revision: 1, model: MODEL_A }]);
		// Three conversations: A is oldest, C is newest. Each gets a single
		// Turn whose `user/message` payload is the first-user-message preview.
		const a = await service.createNew(AGENT_ID);
		const b = await service.createNew(AGENT_ID);
		const c = await service.createNew(AGENT_ID);
		for (const [conv, text] of [
			[a, "first prompt of A — long content " + "x".repeat(120)],
			[b, "first prompt of B"],
			[c, "first prompt of C"],
		] as const) {
			const r = await service.executeTurn(conv.debugConversationId, text, nextTurnId());
			expect(r.ok).toBe(true);
		}
		const items = await service.listHistory(AGENT_ID);
		// Newest first.
		expect(items.map((item) => item.conversationId)).toEqual([
			toPublicId("DebugConversationId", c.debugConversationId),
			toPublicId("DebugConversationId", b.debugConversationId),
			toPublicId("DebugConversationId", a.debugConversationId),
		]);
		// Preview is the FIRST `user/message` payload, truncated to ≤ 60 chars
		// with an ellipsis when longer. No N+1 follow-up: a single repository
		// call already includes the preview.
		const aItem = items.find(
			(item) => item.conversationId === toPublicId("DebugConversationId", a.debugConversationId),
		)!;
		expect(aItem.firstUserMessagePreview).toMatch(/^first prompt of A/);
		expect(aItem.firstUserMessagePreview?.length).toBeLessThanOrEqual(60);
		expect(aItem.firstUserMessagePreview?.endsWith("…")).toBe(true);
		// A conversation with no user message yet (empty binding) surfaces
		// `firstUserMessagePreview: null`, NOT an empty string.
		const empty = await service.createNew(AGENT_ID);
		const itemsAfter = await service.listHistory(AGENT_ID);
		const emptyItem = itemsAfter.find(
			(item) => item.conversationId === toPublicId("DebugConversationId", empty.debugConversationId),
		)!;
		expect(emptyItem.firstUserMessagePreview).toBeNull();
	});

	it("clamps the requested limit to the hard cap and respects the requested floor", async () => {
		const { service } = makeHarness([{ revision: 1, model: MODEL_A }]);
		for (let i = 0; i < 3; i += 1) await service.createNew(AGENT_ID);
		// Default limit returns up to 50.
		expect((await service.listHistory(AGENT_ID)).length).toBe(3);
		// Explicit small limit.
		expect((await service.listHistory(AGENT_ID, 1)).length).toBe(1);
		// 0 / negative fall back to 1 (the service floor).
		expect((await service.listHistory(AGENT_ID, 0)).length).toBe(1);
		// Over the cap (100) is clamped, not rejected.
		expect((await service.listHistory(AGENT_ID, 99999)).length).toBe(3);
	});

	it("scopes the list to (tenant, owner, agentId) — a different agent is invisible", async () => {
		const { service } = makeHarness([{ revision: 1, model: MODEL_A }]);
		const otherAgent = newAgentDefinitionId();
		await service.createNew(AGENT_ID);
		await service.createNew(otherAgent);
		const items = await service.listHistory(AGENT_ID);
		expect(items.length).toBe(1);
		expect(items[0]!.agentId).toBe(toPublicId("AgentDefinitionId", AGENT_ID));
	});
});

describe("DebugConversationService lifecycle (Phase 2F)", () => {
	it("soft-deletes only idle conversations and drops them from History", async () => {
		const { service } = makeHarness([{ revision: 1, model: MODEL_A }]);
		const idle = await service.createNew(AGENT_ID);
		const recent = await service.createNew(AGENT_ID);
		// A real Turn bumps `lastActiveAt`, keeping `recent` above the cutoff.
		const turn = await service.executeTurn(recent.debugConversationId, "keep me", newTurnId());
		expect(turn.ok).toBe(true);
		const cutoff = new Date(idle.lastActiveAt.getTime() + 1);
		const expired = await service.expireIdleSessions(cutoff);
		expect(expired).toEqual([idle.debugConversationId]);
		const history = await service.listHistory(AGENT_ID);
		expect(history.map((item) => item.conversationId)).not.toContain(
			toPublicId("DebugConversationId", idle.debugConversationId),
		);
		expect(history.map((item) => item.conversationId)).toContain(
			toPublicId("DebugConversationId", recent.debugConversationId),
		);
	});

	it("rejects a Turn on a soft-deleted conversation (expired Send behaviour)", async () => {
		const { service } = makeHarness([{ revision: 1, model: MODEL_A }]);
		const conv = await service.createNew(AGENT_ID);
		const [expired] = await service.expireIdleSessions(new Date(conv.lastActiveAt.getTime() + 1));
		expect(expired).toBe(conv.debugConversationId);
		const r = await service.executeTurn(conv.debugConversationId, "hello", newTurnId());
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/unavailable/i);
	});

	it("an appended Turn makes the conversation survive a cutoff it would otherwise have failed (append-then-expire wins)", async () => {
		const { service } = makeHarness([{ revision: 1, model: MODEL_A }]);
		const conv = await service.createNew(AGENT_ID);
		const cutoff = new Date(conv.lastActiveAt.getTime() + 1);
		const turn = await service.executeTurn(conv.debugConversationId, "active now", newTurnId());
		expect(turn.ok).toBe(true);
		const expired = await service.expireIdleSessions(cutoff);
		expect(expired).toEqual([]);
	});

	it("a soft-deleted conversation cannot append (write-side atomic guard)", async () => {
		const { service, capture, repos } = makeHarness([{ revision: 1, model: MODEL_A }]);
		const conv = await service.createNew(AGENT_ID);
		await service.expireIdleSessions(new Date(conv.lastActiveAt.getTime() + 1));
		// Direct append (bypasses the read-side status check) must fail: the
		// repo only appends to `status='active'` rows, mirroring PG.
		const appended = await repos.events.append(
			{ tenantId: TENANT_ID, ownerPrincipalId: OWNER, debugConversationId: conv.debugConversationId },
			conv.debugConversationId,
			{ eventType: "turn/start", turnId: newTurnId(), payload: {} },
		);
		expect(appended).toBeUndefined();
		expect(capture.created).toBe(0);
	});

	it("physical GC removes the row, its events, attachments and citation data, idempotently", async () => {
		const harness = await makeLifecycleHarness();
		const conv = await harness.service.createNew(AGENT_ID);
		const publicId = toPublicId("DebugConversationId", conv.debugConversationId);
		const attachment = await seedSource(harness, publicId, "att-gc", "gc.txt", "indexed content for gc");
		expect(harness.attachments.listBySession(publicId)).toHaveLength(1);
		expect(harness.citations.listSourcesBySession(publicId)).toHaveLength(1);
		expect(harness.citations.store.loadTurnCitations(publicId) ?? undefined).toBeUndefined();
		await harness.citations.persistCitations(publicId, "turn-gc", [
			{
				id: "cit-1",
				sessionId: publicId,
				turnId: "turn-gc",
				sourceId: attachment.id,
				chunkId: `chunk-${attachment.id}`,
				ordinal: 0,
				title: "gc.txt",
				excerpt: "x",
			},
		]);

		await harness.service.expireIdleSessions(new Date(conv.lastActiveAt.getTime() + 1));
		// Grace window expired (deleted_at is ~now; cutoff is +1s).
		const removed = await harness.service.gcPhysical(new Date(Date.now() + 1_000));
		expect(removed).toBeGreaterThan(0);

		// External resources are gone with the canonical row.
		expect(await harness.service.get(conv.debugConversationId)).toBeUndefined();
		expect(harness.attachments.listBySession(publicId)).toHaveLength(0);
		expect(harness.citations.listSourcesBySession(publicId)).toHaveLength(0);
		expect(harness.citations.store.loadTurnCitations(publicId) ?? undefined).toBeUndefined();

		// Re-runnable: a second pass finds nothing to purge.
		const again = await harness.service.gcPhysical(new Date(Date.now() + 1_000));
		expect(again).toBe(0);
	});

	it("physical GC retains the deleted parent when external cleanup fails, then retries successfully", async () => {
		const harness = await makeLifecycleHarness();
		const conv = await harness.service.createNew(AGENT_ID);
		const publicId = toPublicId("DebugConversationId", conv.debugConversationId);
		await seedSource(harness, publicId, "att-gc-retry", "retry.txt", "retry content");
		await harness.service.expireIdleSessions(new Date(conv.lastActiveAt.getTime() + 1));

		const originalRemove = harness.attachments.remove.bind(harness.attachments);
		let failOnce = true;
		harness.attachments.remove = async (id: string) => {
			if (failOnce) {
				failOnce = false;
				throw new Error("injected attachment cleanup failure");
			}
			return originalRemove(id);
		};

		expect(await harness.service.gcPhysical(new Date(Date.now() + 1_000))).toBe(0);
		expect(await harness.service.get(conv.debugConversationId)).toBeDefined();
		expect(harness.attachments.listBySession(publicId)).toHaveLength(1);

		expect(await harness.service.gcPhysical(new Date(Date.now() + 1_000))).toBe(1);
		expect(await harness.service.get(conv.debugConversationId)).toBeUndefined();
		expect(harness.attachments.listBySession(publicId)).toHaveLength(0);
		expect(harness.citations.listSourcesBySession(publicId)).toHaveLength(0);
	});

	it("headless executeTurn releases the runtime after each Turn (no runtime accumulation)", async () => {
		const { service, capture } = makeHarness([{ revision: 1, model: MODEL_A }]);
		const conv = await service.createNew(AGENT_ID);
		const first = await service.executeTurn(conv.debugConversationId, "one", newTurnId());
		expect(first.ok).toBe(true);
		const second = await service.executeTurn(conv.debugConversationId, "two", newTurnId());
		expect(second.ok).toBe(true);
		// If the runtime were leaked for headless turns, the second Turn would
		// reuse it (1 session creation). Releasing after each Turn therefore
		// yields a fresh session per Turn.
		expect(capture.created).toBe(2);
	});

	it("persists direct attachmentIds as a per-Turn user/message fact", async () => {
		const { service } = makeHarness([{ revision: 1, model: MODEL_A }]);
		const conv = await service.createNew(AGENT_ID);
		for (const attachmentIds of [["A"], [], ["A"]]) {
			const result = await service.executeTurn(conv.debugConversationId, "attachment turn", newTurnId(), {
				attachmentIds,
			});
			expect(result.ok).toBe(true);
		}
		const userEvents = (await service.listEvents(conv.debugConversationId)).filter(
			(event) => event.eventType === "user/message",
		);
		expect(userEvents.map((event) => (event.payload as { attachmentIds: string[] }).attachmentIds)).toEqual([
			["A"],
			[],
			["A"],
		]);
	});
});
