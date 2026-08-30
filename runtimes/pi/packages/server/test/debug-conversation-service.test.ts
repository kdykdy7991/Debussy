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
	return {
		conversations: {
			async insert(record: DebugConversationRecord) {
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
				return byId.get(scope.debugConversationId);
			},
			async setStatus(scope, status) {
				const rec = byId.get(scope.debugConversationId);
				if (rec === undefined || rec.status !== "active") return false;
				rec.status = status;
				return true;
			},
		},
		events: {
			async append(_scope, conversationId, input: DebugConversationEventInput) {
				if (!eventCounters.has(conversationId)) eventCounters.set(conversationId, 0);
				const next = (eventCounters.get(conversationId) ?? 0) + 1;
				eventCounters.set(conversationId, next);
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
		debug: createFakeDebugRepos(),
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

	it("reuses the Runtime on identical spec and rebuilds + carries history on a revision change", async () => {
		const { service, capture, advanceRevision, nextTurnId } = makeHarness([
			{ revision: 1, model: MODEL_A },
			{ revision: 2, model: MODEL_B },
		]);

		const conv = await service.createNew(AGENT_ID);

		// Turn 1 @ rev 1
		const t1 = await service.executeTurn(conv.debugConversationId, "TurnOne", nextTurnId());
		expect(t1.ok).toBe(true);
		expect(capture.created).toBe(1);

		// Turn 2 @ same revision: Runtime reused, history carried.
		const t2 = await service.executeTurn(conv.debugConversationId, "TurnTwo", nextTurnId());
		expect(t2.ok).toBe(true);
		expect(capture.created).toBe(1);
		const turn2Prompt = capture.prompts[1]!;
		expect(turn2Prompt.text).toBe("TurnTwo");
		expect(turn2Prompt.retrieval?.context).toContain("TurnOne");
		expect(turn2Prompt.retrieval?.context).toContain("echo:TurnOne");

		// Revision change: next Turn rebuilds the Runtime but keeps THIS conversation.
		advanceRevision();
		const t3 = await service.executeTurn(conv.debugConversationId, "TurnThree", nextTurnId());
		expect(t3.ok).toBe(true);
		expect(capture.created).toBe(2);
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
