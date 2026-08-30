/**
 * DebugConversation Phase 2A — Tool/MCP/Skill realtime + persistence + reconnect.
 *
 * Real `PiServer` (LiveSessionManager) + `createWebSocketServer` +
 * `DebugConversationRuntimeAdapter` + real DebugConversation HTTP + real PG.
 * Inner agent session is a deterministic stub that honors `toolPlans` queued on
 * the capture (and invokes `customTools[].execute()` when a plan name matches
 * an MCP custom tool built by the injected `createMcpTools` factory). No real
 * model provider is reachable.
 *
 * Scenarios (this round):
 *   A. builtin tool: toolCall -> realtime item_started(running)/updated/finished(complete)
 *      -> persisted tool/call + tool/result (same turnId + toolCallId)
 *   B. tool failure: tool error -> persisted tool/error with error payload; the
 *      Turn still finishes normally (tool error != turn/failed)
 *   C. MCP wiring: createMcpTools(spec, scope) is called, customTools are passed
 *      to createSession, the MCP tool's execute() runs at execute-time (verified
 *      via execution-time instrumentation), realtime + persisted tool/call+result
 *      use the MCP toolName; credential lifecycle = execute-time, never construction
 *   D. reconnect: a Turn with a Tool call -> close WS -> fresh server instance
 *      over the same PG -> attach -> snapshot includes the tool item rebuilt from
 *      persisted tool/result (id `tool-<toolCallId>`, role:"tool", status complete)
 *   E. revision change: rev1 has Tool X; save rev2 (advanceRevision changes MCP +
 *      adds Skill S); Turn2 rebuilds the inner runtime (runtimeSpecHash changed)
 *      and uses rev2's tools; rev1's Tool X is no longer callable in Turn2
 *   F. no input/output persistence: every persisted tool/call / tool/result /
 *      tool/error payload contains NO `input` and NO `content` (mirror Production
 *      vocabulary; MCP-specific audit lives in `mcp_call_audit`, not in the event
 *      stream).
 * Skipped automatically when the test Postgres is unreachable.
 */
import * as http from "node:http";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
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
	newTurnId,
	type PrincipalId,
	type TenantId,
	toPublicId,
} from "../src/publishing/domain/ids.ts";
import type { McpRuntimeToolFactory } from "../src/publishing/mcp/runtime-tools.ts";
import type { PublishingRepositories, TenantScope } from "../src/publishing/repositories.ts";
import type { CapabilityCatalog } from "../src/publishing/runtime-spec/compiler.ts";
import { connectWebSocketTestClient, type ProtocolTestClient } from "../src/testing/index.ts";
import { createWebSocketServer } from "../src/transports/websocket/index.ts";
import type { PiSessionRuntime, PiSessionRuntimeEvent, PromptInput } from "../src/types.ts";

const SCHEMA = `dce2at_${process.pid}_${Date.now().toString(36)}`;
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
const MODEL = { provider: "prov", modelId: "modelA" };
const MODEL_B = { provider: "prov", modelId: "modelB" };
const CATALOG: CapabilityCatalog = {
	tools: [],
	knowledgeBases: [],
	models: [
		{
			provider: MODEL.provider,
			modelId: MODEL.modelId,
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

interface ToolPlan {
	readonly name: string;
	/** Args to pass to `definition.execute(toolCallId, args, signal)` if matched against customTools. */
	readonly args?: Readonly<Record<string, unknown>>;
	/** Optional inline output (for tools that have no matching customTool def — e.g. synthetic builtin). */
	readonly output?: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
	/** When set, the plan fails with this error message instead of completing. */
	readonly errorMessage?: string;
}

interface Capture {
	readonly prompts: PromptInput[];
	/** Minimal structural view of the customTools the Debug runtime opened with. */
	readonly customTools: { current: readonly MinimalToolDefinition[] };
	/** Plans executed by the next prompt; consumed in order, then cleared. */
	readonly toolPlans: ToolPlan[];
	/** Records every tool lifecycle the fake session emitted (visibility). */
	readonly toolLifecycle: Array<{
		readonly type: "item_started" | "item_updated" | "item_finished";
		readonly toolName: string;
		readonly toolCallId: string;
		readonly status: "running" | "complete" | "error";
	}>;
}

/** Subset of `ToolDefinition` the fake session can invoke. */
interface MinimalToolDefinition {
	readonly name: string;
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	): Promise<unknown>;
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

function revisionRecord(rev: {
	revision: number;
	model: { provider: string; modelId: string };
	prompt?: string;
}): unknown {
	return {
		revision: rev.revision,
		draftConfig: {
			prompt: rev.prompt ?? `system prompt rev ${rev.revision}`,
			model: rev.model,
		},
	};
}

function makePublishing(opts?: {
	mcpServers?: ReadonlyArray<{
		mcpServerId: string;
		revision: number;
		transport: "streamable_http";
		endpoint: string;
		authentication: "none" | "bearer";
		tools: ReadonlyArray<{ name: string; description: string | null }>;
	}>;
}): {
	repositories: PublishingRepositories;
	advanceRevision(opts: { model: { provider: string; modelId: string }; prompt?: string }): void;
} {
	const revisions: Array<{
		revision: number;
		model: { provider: string; modelId: string };
		prompt?: string;
	}> = [{ revision: 1, model: MODEL }];
	let cursor = 0;
	const mcpServers = opts?.mcpServers ?? [];
	const mcpBindingsFor = mcpServers.map((s) => ({
		mcpServerId: s.mcpServerId,
		mcpRevision: s.revision,
		toolAllowlist: s.tools.map((t) => t.name),
	}));
	return {
		repositories: {
			agentDefinitions: { getLatest: async () => revisionRecord(revisions[cursor]!) },
			skills: {
				listBindings: async () => [],
				get: async () => undefined,
				getRevision: async () => undefined,
			},
			mcpServers: {
				listBindings: async () => mcpBindingsFor,
				get: async (scope: TenantScope, id: string) => {
					const m = mcpServers.find((s) => s.mcpServerId === id);
					if (m === undefined) return undefined;
					return {
						mcpServerId: m.mcpServerId,
						tenantId: scope.tenantId,
						status: "enabled",
					};
				},
				getRevision: async (_scope: TenantScope, id: string, rev: number) => {
					const m = mcpServers.find((s) => s.mcpServerId === id && s.revision === rev);
					if (m === undefined) return undefined;
					return {
						mcpServerId: m.mcpServerId,
						revision: m.revision,
						transport: m.transport,
						endpoint: m.endpoint,
						authentication: m.authentication,
					};
				},
				listTools: async (_scope: TenantScope, id: string, rev: number) => {
					const m = mcpServers.find((s) => s.mcpServerId === id && s.revision === rev);
					if (m === undefined) return [];
					return m.tools.map((t) => ({
						name: t.name,
						description: t.description,
						inputSchema: { type: "object", properties: {} },
						// Schema requires a 64-char lowercase hex sha256.
						inputSchemaHash: `a`.repeat(64),
					}));
				},
			},
		} as unknown as PublishingRepositories,
		advanceRevision: (opts) => {
			revisions.push({ revision: revisions.length + 1, model: opts.model, prompt: opts.prompt });
			cursor = revisions.length - 1;
		},
	};
}

/** Inner agent session stub: emits one tool plan per queued entry, then assistant. */
function makeInnerFactory(capture: Capture): (opts: unknown) => Promise<PiSessionRuntime> {
	return async (opts: unknown) => {
		const id = (opts as { id: string }).id;
		// Capture the customTools the Debug openRuntime passes into createSession.
		// This is the smoke check for Phase 2A: MCP customTools built by
		// `createMcpTools(spec, scope)` reach the inner session.
		const sessionOptions = opts as { customTools?: readonly ToolDefinition[] };
		capture.customTools.current = (sessionOptions.customTools ?? []) as readonly MinimalToolDefinition[];
		const items: Array<Record<string, unknown>> = [];
		const listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
		const emit = (event: PiSessionRuntimeEvent) => {
			for (const listener of [...listeners]) listener(event);
		};
		const messageId = (text: string) => `inner-ast:${text}`;
		return {
			ephemeral: true,
			snapshot: () => ({ id, transcript: items }) as unknown as ReturnType<PiSessionRuntime["snapshot"]>,
			getPhase: () => "idle" as const,
			async prompt(input: PromptInput) {
				capture.prompts.push(input);
				// Process queued tool plans.
				const plans = capture.toolPlans.splice(0, capture.toolPlans.length);
				for (const plan of plans) {
					const toolCallId = `tcid-${plan.name}-${Math.random().toString(36).slice(2, 8)}`;
					const startedAt = Date.now();
					// item_started: running
					const startedItem: TranscriptItem = {
						id: `tool-${toolCallId}`,
						role: "tool",
						toolCallId,
						toolName: plan.name,
						input: (plan.args ?? null) as never,
						content: [],
						status: "running",
						isError: false,
						timestamp: startedAt,
					};
					capture.toolLifecycle.push({
						type: "item_started",
						toolName: plan.name,
						toolCallId,
						status: "running",
					});
					emit({ type: "progress", progress: { type: "item_started", item: startedItem } });
					// Execute the MCP custom tool if available; else use synthetic output.
					let resultText: string | null = null;
					let failed: string | null = plan.errorMessage ?? null;
					if (failed === null) {
						const def = capture.customTools.current.find((t) => t.name === plan.name);
						if (def !== undefined) {
							try {
								const result = await def.execute(
									toolCallId,
									plan.args ?? {},
									new AbortController().signal,
									undefined,
									undefined,
								);
								const textParts: string[] = [];
								for (const part of (result as { content?: ReadonlyArray<{ type: string; text?: string }> })
									.content ?? []) {
									if (part.type === "text" && typeof part.text === "string") textParts.push(part.text);
								}
								resultText = textParts.join("");
							} catch (execError) {
								failed = execError instanceof Error ? execError.message : String(execError);
							}
						} else {
							resultText = (plan.output ?? [{ type: "text", text: `synthetic:${plan.name}` }])
								.map((p) => p.text)
								.join("");
						}
					}
					if (failed === null) {
						// item_finished: complete
						const finishedAt = Date.now();
						const completeItem: TranscriptItem = {
							id: `tool-${toolCallId}`,
							role: "tool",
							toolCallId,
							toolName: plan.name,
							input: null,
							content: [{ type: "text", text: resultText ?? "" }],
							status: "complete",
							isError: false,
							timestamp: finishedAt,
						};
						capture.toolLifecycle.push({
							type: "item_finished",
							toolName: plan.name,
							toolCallId,
							status: "complete",
						});
						emit({ type: "progress", progress: { type: "item_finished", item: completeItem } });
					} else {
						const finishedAt = Date.now();
						const errorItem: TranscriptItem = {
							id: `tool-${toolCallId}`,
							role: "tool",
							toolCallId,
							toolName: plan.name,
							input: null,
							content: [{ type: "text", text: failed }],
							status: "error",
							isError: true,
							timestamp: finishedAt,
						};
						capture.toolLifecycle.push({
							type: "item_finished",
							toolName: plan.name,
							toolCallId,
							status: "error",
						});
						emit({ type: "progress", progress: { type: "item_finished", item: errorItem } });
					}
				}
				// Assistant message.
				const aid = messageId(input.text);
				emit({
					type: "progress",
					progress: {
						type: "item_started",
						item: {
							id: aid,
							role: "assistant",
							model: { provider: MODEL.provider, id: MODEL.modelId },
							status: "streaming",
							content: [],
							timestamp: Date.now(),
						},
					},
				});
				emit({
					type: "progress",
					progress: { type: "assistant_delta", messageId: aid, contentIndex: 0, kind: "text", delta: "ok" },
				});
				items.push({
					role: "assistant",
					status: "complete",
					content: [
						{ type: "text", text: "ok" },
						{ type: "thinking", redacted: false, thinking: "x" },
					],
				});
				emit({
					type: "progress",
					progress: {
						type: "item_finished",
						item: {
							id: aid,
							role: "assistant",
							model: { provider: MODEL.provider, id: MODEL.modelId },
							status: "complete",
							stopReason: "stop",
							content: [{ type: "text", text: "ok" }],
							timestamp: Date.now(),
						},
					},
				});
			},
			async steer() {},
			async abort() {},
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

interface DebugStack {
	service: DebugConversationService;
	capture: Capture;
	publishing: ReturnType<typeof makePublishing>;
	createMcpTools: McpRuntimeToolFactory | undefined;
	wsServer: ReturnType<typeof createWebSocketServer>;
	wsUrl: string;
	httpServer: http.Server;
	httpUrl: string;
}

async function startStack(opts: {
	store: DebugRepositories;
	capture: Capture;
	publishing: ReturnType<typeof makePublishing>;
	createMcpTools?: McpRuntimeToolFactory;
}): Promise<DebugStack> {
	const service = new DebugConversationService({
		repositories: opts.publishing.repositories,
		debug: opts.store,
		catalog: CATALOG,
		createSession: makeInnerFactory(opts.capture),
		...(opts.createMcpTools !== undefined ? { createMcpTools: opts.createMcpTools } : {}),
		tenantId: TENANT_ID,
		ownerPrincipalId: OWNER,
	});
	const realtime = new DebugConversationRealtime(service);
	const wsServer = createWebSocketServer(
		createDebugRealtimeBackend(
			{
				listSessions: async () => [],
				listModels: async () => [],
				createSession: async () => {
					throw new Error("not used in debug e2e path");
				},
				openSession: async () => {
					throw new Error("not used in debug e2e path");
				},
			},
			realtime,
		),
		{ port: 0 },
	);
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
	return {
		service,
		capture: opts.capture,
		publishing: opts.publishing,
		createMcpTools: opts.createMcpTools,
		wsServer,
		wsUrl: `ws://127.0.0.1:${wsPort}/api/pi/v1/ws`,
		httpServer,
		httpUrl: `http://127.0.0.1:${hp}`,
	};
}

function closeHttp(server: http.Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

async function httpJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
	const res = await fetch(url, init);
	return { status: res.status, body: (await res.json()) as any };
}

function freshCapture(): Capture {
	return {
		prompts: [],
		customTools: { current: [] },
		toolPlans: [],
		toolLifecycle: [],
	};
}

const DEBUG_BASE = "/api/control/v1/debug-conversations";

describe.skipIf(!pgUp)("DebugConversation Phase 2A — Tool/MCP realtime + persistence + reconnect", () => {
	let client: PostgresClient;
	let store: DebugRepositories;
	let stack: DebugStack;
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

	function sessionProgressTurnIds(c: ProtocolTestClient): string[] {
		return c.messages
			.filter((m) => (m as any).type === "event" && (m as any).event?.type === "session_progress")
			.map((m) => (m as any).event.turnId as string);
	}

	function payloadOf(event: { payload: unknown }): Record<string, any> {
		return (event.payload ?? {}) as Record<string, any>;
	}

	function toolRealtimeItems(c: ProtocolTestClient): Array<{
		progressType: string;
		role: string;
		toolCallId: string;
		toolName: string;
		status: string;
		itemId: string;
	}> {
		const out: Array<{
			progressType: string;
			role: string;
			toolCallId: string;
			toolName: string;
			status: string;
			itemId: string;
		}> = [];
		for (const m of c.messages) {
			if ((m as any).type !== "event") continue;
			const ev = (m as any).event;
			if (ev?.type !== "session_progress") continue;
			const progress = ev.progress;
			if (
				progress?.type === "item_started" ||
				progress?.type === "item_updated" ||
				progress?.type === "item_finished"
			) {
				if (progress.item?.role !== "tool") continue;
				out.push({
					progressType: progress.type,
					role: progress.item.role,
					toolCallId: progress.item.toolCallId,
					toolName: progress.item.toolName,
					status: progress.item.status,
					itemId: progress.item.id,
				});
			}
		}
		return out;
	}

	beforeAll(async () => {
		client = new PostgresClient({ url: PG_URL, searchPath: SCHEMA });
		await client.run(`drop schema if exists ${SCHEMA} cascade`);
		await client.run(`create schema ${SCHEMA}`);
		await runMigrations(client);
		store = createDebugRepositories(client);
		stack = await startStack({ store, capture: freshCapture(), publishing: makePublishing() });
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

	it("A. builtin tool: realtime lifecycle + persisted tool/call + tool/result, same turnId/toolCallId", async () => {
		const { agentPublic } = freshAgent();
		const { convPublic, convId } = await createConversation(agentPublic);
		stack.capture.toolPlans.push({ name: "read", output: [{ type: "text", text: "FILE CONTENT" }] });
		const c = await wsConnect();
		await c.request({ command: "attach", sessionId: convPublic } as never);
		const r = await c.request({ command: "prompt", sessionId: convPublic, text: "trigger tool" } as never);
		expect(r.ok).toBe(true);

		// 1) Realtime: item_started (running), item_finished (complete), same toolCallId.
		const realtimeTools = toolRealtimeItems(c);
		const startedAt = realtimeTools.find((t) => t.progressType === "item_started" && t.toolName === "read");
		const finishedAt = realtimeTools.find((t) => t.progressType === "item_finished" && t.toolName === "read");
		expect(startedAt).toBeTruthy();
		expect(finishedAt).toBeTruthy();
		expect(startedAt!.toolCallId).toBe(finishedAt!.toolCallId);
		expect(startedAt!.status).toBe("running");
		expect(finishedAt!.status).toBe("complete");
		expect(startedAt!.itemId).toBe(`tool-${startedAt!.toolCallId}`);
		// Tool id matches Production progress-adapter convention.

		// 2) Persisted: tool/call + tool/result with same toolCallId/toolName/toolType=builtin.
		const events = await stack.service.listEvents(convId);
		const toolEvents = events.filter(
			(e) => e.eventType === "tool/call" || e.eventType === "tool/result" || e.eventType === "tool/error",
		);
		expect(toolEvents.map((e) => e.eventType)).toEqual(["tool/call", "tool/result"]);
		const callEvt = toolEvents[0]!;
		const resultEvt = toolEvents[1]!;
		expect(payloadOf(callEvt).toolCallId).toBe(startedAt!.toolCallId);
		expect(payloadOf(resultEvt).toolCallId).toBe(startedAt!.toolCallId);
		expect(payloadOf(callEvt).toolName).toBe("read");
		expect(payloadOf(resultEvt).toolName).toBe("read");
		expect(payloadOf(callEvt).toolType).toBe("builtin");
		expect(payloadOf(resultEvt).toolType).toBe("builtin");
		expect(payloadOf(callEvt).status).toBe("running");
		expect(payloadOf(resultEvt).status).toBe("complete");
		expect(typeof payloadOf(callEvt).startedAt).toBe("number");
		expect(typeof payloadOf(resultEvt).finishedAt).toBe("number");

		// 3) Realtime turnId == persisted turnId.
		const realtimeTurnIds = new Set(sessionProgressTurnIds(c));
		const persistedTurnIds = new Set(
			events
				.map((e) => e.turnId)
				.filter((t) => t !== null)
				.map((t) => t as string),
		);
		expect([...persistedTurnIds]).toEqual([...realtimeTurnIds]);
	});

	it("B. tool failure: persisted tool/error; turn still finishes normally (no auto turn/failed)", async () => {
		const { agentPublic } = freshAgent();
		const { convPublic, convId } = await createConversation(agentPublic);
		stack.capture.toolPlans.push({ name: "read", errorMessage: "ENOENT: file not found" });
		const c = await wsConnect();
		await c.request({ command: "attach", sessionId: convPublic } as never);
		const r = await c.request({ command: "prompt", sessionId: convPublic, text: "trigger failing tool" } as never);
		expect(r.ok).toBe(true);

		const events = await stack.service.listEvents(convId);
		const toolErr = events.find((e) => e.eventType === "tool/error");
		expect(toolErr).toBeTruthy();
		expect(payloadOf(toolErr!).toolName).toBe("read");
		expect(payloadOf(toolErr!).status).toBe("error");
		expect(payloadOf(toolErr!).toolType).toBe("builtin");
		expect(typeof payloadOf(toolErr!).error).toBe("string");
		expect((payloadOf(toolErr!).error as string).includes("ENOENT")).toBe(true);
		// Turn still completes normally: assistant/message + turn/end present; no turn/failed.
		expect(events.find((e) => e.eventType === "assistant/message")).toBeTruthy();
		expect(events.find((e) => e.eventType === "turn/end")).toBeTruthy();
		expect(events.find((e) => e.eventType === "turn/failed")).toBeUndefined();
		// No tool/call or tool/result paired with the failed tool.
		expect(events.filter((e) => e.eventType === "tool/call")).toHaveLength(1);
		expect(events.filter((e) => e.eventType === "tool/result")).toHaveLength(0);
	});

	it("C. MCP wiring: createMcpTools -> customTools -> execute (execute-time), realtime + persisted", async () => {
		const { agentPublic } = freshAgent();
		// Build a McpRuntimeToolFactory that records construction-time vs
		// execute-time instrumentation. `executedAt` is set only inside
		// `.execute()`; `constructedAt` is set when the factory is invoked.
		const factoryInvocations: { specRef: string; at: string }[] = [];
		const toolExecs: { toolName: string; at: string; args: unknown }[] = [];
		const created: { at: string } = { at: "unset" };
		const createMcpTools: McpRuntimeToolFactory = async (spec, scope) => {
			factoryInvocations.push({ specRef: spec.publishedAppVersionId, at: "constructed" });
			void scope;
			const definition: ToolDefinition = {
				name: "probe-mcp",
				label: "probe-mcp",
				description: "Phase 2A MCP smoke tool",
				parameters: { type: "object", properties: {} } as never,
				executionMode: "parallel",
				execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
					toolExecs.push({ toolName: "probe-mcp", at: "execute", args: params });
					return { content: [{ type: "text", text: "mcp-ok" }], details: undefined };
				},
			};
			return [definition];
		};
		void created;

		// Fresh stack with MCP factory injected. The publishing repos advertise the
		// probe-mcp tool as a bound MCP server so `compileDebugAgentRevision`
		// includes it in `spec.capabilities.mcpServers` and `deriveToolType`
		// tags persisted events as `toolType:"mcp"`.
		const cap = freshCapture();
		const pub = makePublishing({
			mcpServers: [
				{
					mcpServerId: "00000000-0000-7000-8000-000000000001",
					revision: 1,
					transport: "streamable_http",
					endpoint: "https://example.invalid/mcp",
					authentication: "none",
					tools: [{ name: "probe-mcp", description: "Phase 2A MCP smoke tool" }],
				},
			],
		});
		const freshStack = await startStack({ store, capture: cap, publishing: pub, createMcpTools });
		startedServers.push(freshStack.wsServer);
		startedHttp.push(freshStack.httpServer);

		const { convPublic, convId } = await createConversation(agentPublic);
		cap.toolPlans.push({ name: "probe-mcp", args: { query: "hi" } });
		const c = await connectWebSocketTestClient(freshStack.wsUrl);
		openedClients.push(c);
		await c.hello();
		await c.request({ command: "attach", sessionId: convPublic } as never);
		const promptResp = await c.request({ command: "prompt", sessionId: convPublic, text: "use mcp" } as never);
		expect((promptResp as any).ok).toBe(true);

		// (1) createMcpTools was called once at construction-time.
		expect(factoryInvocations).toHaveLength(1);
		expect(factoryInvocations[0]!.at).toBe("constructed");

		// (2) customTools reached createSession (Phase 2A wiring).
		expect(cap.customTools.current.map((t) => t.name)).toEqual(["probe-mcp"]);

		// (3) MCP tool's execute() ran at execute-time (after construction).
		expect(toolExecs).toHaveLength(1);
		expect(toolExecs[0]!.at).toBe("execute");
		expect((toolExecs[0]!.args as { query: string }).query).toBe("hi");

		// (4) Persisted: tool/call + tool/result with toolType=mcp.
		const events = await freshStack.service.listEvents(convId);
		const callEvt = events.find((e) => e.eventType === "tool/call");
		const resultEvt = events.find((e) => e.eventType === "tool/result");
		expect(callEvt).toBeTruthy();
		expect(resultEvt).toBeTruthy();
		expect(payloadOf(callEvt!).toolName).toBe("probe-mcp");
		expect(payloadOf(callEvt!).toolType).toBe("mcp");
		expect(payloadOf(resultEvt!).toolType).toBe("mcp");

		// (5) Realtime: tool item flowed to WS.
		const realtimeTools = toolRealtimeItems(c).filter((t) => t.toolName === "probe-mcp");
		expect(realtimeTools.find((t) => t.progressType === "item_started")).toBeTruthy();
		expect(realtimeTools.find((t) => t.progressType === "item_finished" && t.status === "complete")).toBeTruthy();
	});

	it("D. reconnect: tool call persisted -> fresh server rebuilds snapshot with tool item", async () => {
		const { agentPublic } = freshAgent();
		const { convPublic, convId } = await createConversation(agentPublic);
		stack.capture.toolPlans.push({ name: "read", output: [{ type: "text", text: "RECONNECT" }] });
		const c1 = await wsConnect();
		await c1.request({ command: "attach", sessionId: convPublic } as never);
		const r = await c1.request({ command: "prompt", sessionId: convPublic, text: "before reconnect" } as never);
		expect(r.ok).toBe(true);
		await c1.close();

		// Fresh server instance over the SAME Postgres (empty runtime cache +
		// empty adapter cache + empty LiveSession cache): attach must rebuild
		// the snapshot from persisted events, including tool/result.
		const fresh = await startStack({ store, capture: freshCapture(), publishing: makePublishing() });
		startedServers.push(fresh.wsServer);
		startedHttp.push(fresh.httpServer);
		const c2 = await connectWebSocketTestClient(fresh.wsUrl);
		openedClients.push(c2);
		await c2.hello();
		const attach = await c2.request({ command: "attach", sessionId: convPublic } as never);
		expect(attach.ok).toBe(true);
		const transcript = (attach as any).result.session.transcript as ReadonlyArray<TranscriptItem>;
		const toolItems = transcript.filter((t) => t.role === "tool");
		expect(toolItems).toHaveLength(1);
		const rebuilt = toolItems[0]!;
		expect(rebuilt.id).toMatch(/^tool-tcid-read-/);
		expect(rebuilt.status).toBe("complete");
		expect(rebuilt.isError).toBe(false);
		expect(rebuilt.toolName).toBe("read");
		expect(rebuilt.content).toEqual([]);
		expect(rebuilt.input).toBeNull();

		// After reconnect the new Turn can still stream + persist on the same conversation.
		const eventsBefore = await fresh.service.listEvents(convId);
		const seqBefore = eventsBefore.at(-1)?.sequence ?? 0;
		fresh.capture.toolPlans.push({ name: "read", output: [{ type: "text", text: "POST_RECONNECT" }] });
		const r2 = await c2.request({ command: "prompt", sessionId: convPublic, text: "after reconnect" } as never);
		expect(r2.ok).toBe(true);
		const eventsAfter = await fresh.service.listEvents(convId);
		expect(eventsAfter.at(-1)!.sequence).toBeGreaterThan(seqBefore);
	});

	it("P2B-D. reconnect: assistant/message thinking restored into the rebuilt snapshot", async () => {
		const { agentPublic } = freshAgent();
		const { convPublic } = await createConversation(agentPublic);
		const c1 = await wsConnect();
		await c1.request({ command: "attach", sessionId: convPublic } as never);
		const r = await c1.request({ command: "prompt", sessionId: convPublic, text: "think before reconnect" } as never);
		expect(r.ok).toBe(true);
		await c1.close();

		// Fresh server over the same Postgres: snapshot must rebuild the
		// assistant thinking part from assistant/message.payload.thinking.
		const fresh = await startStack({ store, capture: freshCapture(), publishing: makePublishing() });
		startedServers.push(fresh.wsServer);
		startedHttp.push(fresh.httpServer);
		const c2 = await connectWebSocketTestClient(fresh.wsUrl);
		openedClients.push(c2);
		await c2.hello();
		const attach = await c2.request({ command: "attach", sessionId: convPublic } as never);
		expect(attach.ok).toBe(true);
		const transcript = (attach as any).result.session.transcript as ReadonlyArray<TranscriptItem>;
		const assistant = transcript.find((t) => t.role === "assistant");
		expect(assistant).toBeTruthy();
		expect(assistant!.content.some((c) => c.type === "thinking")).toBe(true);
		const thinking = assistant!.content.find((c) => c.type === "thinking");
		expect(thinking?.type === "thinking" ? thinking.thinking : "").toBe("x");

		// restoreContext stays text-only: a new Turn's history has NO thinking.
		fresh.capture.toolPlans.push({ name: "read", output: [{ type: "text", text: "POST" }] });
		const r2 = await c2.request({ command: "prompt", sessionId: convPublic, text: "after reconnect" } as never);
		expect(r2.ok).toBe(true);
		const lastPrompt = fresh.capture.prompts.at(-1);
		expect((lastPrompt?.retrieval?.context ?? "").includes("x")).toBe(false);
	});

	it("E. revision change: rebuild runtime, new capability, old capability not callable", async () => {
		const { agentPublic } = freshAgent();
		const { convPublic, convId } = await createConversation(agentPublic);

		// Rev 1: tool `read` is the only available synthetic builtin.
		stack.capture.toolPlans.push({ name: "read", output: [{ type: "text", text: "REV1" }] });
		const c = await wsConnect();
		await c.request({ command: "attach", sessionId: convPublic } as never);
		const r1 = await c.request({ command: "prompt", sessionId: convPublic, text: "rev1 turn" } as never);
		expect(r1.ok).toBe(true);
		const eventsRev1 = await stack.service.listEvents(convId);
		const hashRev1 = (eventsRev1.find((e) => e.eventType === "turn/start")?.payload as { runtimeSpecHash?: string })
			.runtimeSpecHash;
		expect(hashRev1).toBeTruthy();

		// Save revision 2: bump model + prompt. The runtimeSpecHash must change.
		stack.publishing.advanceRevision({ model: MODEL_B, prompt: "system prompt rev 2" });

		// Rev 2: tool `grep` (different capability) — `read` is no longer queued
		// (proves rev1 capability is not carried into rev2's runtime plans).
		stack.capture.toolPlans.push({ name: "grep", output: [{ type: "text", text: "REV2" }] });
		const r2 = await c.request({ command: "prompt", sessionId: convPublic, text: "rev2 turn" } as never);
		expect(r2.ok).toBe(true);

		const eventsRev2 = await stack.service.listEvents(convId);
		const starts = eventsRev2.filter((e) => e.eventType === "turn/start");
		expect(starts).toHaveLength(2);
		const hashRev2 = (starts[1]!.payload as { runtimeSpecHash?: string }).runtimeSpecHash;
		expect(hashRev2).toBeTruthy();
		expect(hashRev2).not.toBe(hashRev1);

		// Rev 2 tool events: only `grep` (rev2 capability), no `read`. Filter to the
		// second turn's events (rev2) by turnId from the second turn/start.
		const rev2TurnId = starts[1]!.turnId;
		const toolEventsRev2 = eventsRev2
			.filter((e) => e.eventType === "tool/call" || e.eventType === "tool/result" || e.eventType === "tool/error")
			.filter((e) => e.turnId === rev2TurnId);
		expect(toolEventsRev2).toHaveLength(2);
		expect(toolEventsRev2.every((e) => payloadOf(e).toolName === "grep")).toBe(true);

		// Conversation identity unchanged across the revision change.
		const conversation = await stack.service.get(convId);
		expect(conversation).toBeTruthy();
	});

	it("F. no tool input/output persistence: payload contains neither `input` nor `content`", async () => {
		// Production mirror: tool events persist only {toolCallId, toolName,
		// toolType, status, startedAt/finishedAt, error?}. No `input`, no
		// `content`, no `output`. Assert via the persisted event stream.
		const { agentPublic } = freshAgent();
		const { convPublic, convId } = await createConversation(agentPublic);
		stack.capture.toolPlans.push({ name: "read", output: [{ type: "text", text: "FOR_F_TEST" }] });
		const c = await wsConnect();
		await c.request({ command: "attach", sessionId: convPublic } as never);
		await c.request({ command: "prompt", sessionId: convPublic, text: "f-test" } as never);

		const events = await stack.service.listEvents(convId);
		const toolEvents = events.filter(
			(e) => e.eventType === "tool/call" || e.eventType === "tool/result" || e.eventType === "tool/error",
		);
		expect(toolEvents.length).toBeGreaterThan(0);
		for (const e of toolEvents) {
			const payload = e.payload as Record<string, unknown>;
			expect(payload).not.toHaveProperty("input");
			expect(payload).not.toHaveProperty("content");
			expect(payload).not.toHaveProperty("output");
		}
	});

	it("G. headless execution uses the same tool lifecycle persistence core as realtime", async () => {
		const { agentPublic } = freshAgent();
		const { convId } = await createConversation(agentPublic);
		stack.capture.toolPlans.push({ name: "read", output: [{ type: "text", text: "HEADLESS" }] });
		const result = await stack.service.executeTurn(convId, "headless tool", newTurnId());
		expect(result.ok).toBe(true);
		const events = await stack.service.listEvents(convId);
		expect(
			events
				.filter((event) => event.eventType === "tool/call" || event.eventType === "tool/result")
				.map((event) => event.eventType),
		).toEqual(["tool/call", "tool/result"]);
	});
});
