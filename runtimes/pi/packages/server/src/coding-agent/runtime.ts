/**
 * Runtime adapter: wraps a Coding Agent `AgentSession` and exposes it through
 * the server-side `PiSessionRuntime` interface.
 *
 * Responsibilities:
 *
 *  - Hold the live `AgentSession` and its underlying `SessionManager`.
 *  - Translate `prompt` / `steer` / `abort` / `setModel` / `setThinking` calls
 *    into the matching AgentSession method (or throw `busy` / `invalid_state`
 *    errors via `PiServerError` when the harness cannot accept them).
 *  - Forward AgentSession events as `TranscriptProgress` until the runtime
 *    emits a final authoritative `SessionSnapshot` after each operation.
 *  - Dispose the AgentSession and stop progress forwarding on `dispose()`.
 */
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentSession, AttachmentInput, PromptContextBlock } from "@earendil-works/pi-coding-agent";
import type {
	ModelRef,
	SessionPhase,
	SessionSnapshot,
	ThinkingLevel,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";
import { PiServerError } from "../errors.ts";
import { redact } from "../logging/redact.ts";
import type {
	PiSessionRuntime,
	PiSessionRuntimeEvent,
	PromptInput,
	ResolvedAttachmentInput,
	SteerInput,
} from "../types.ts";
import { toAgentMessages } from "./history-mapper.ts";
import { subscribeToAgentSession } from "./progress-adapter.ts";
import { buildSessionSnapshot, type RuntimeHints } from "./snapshot-adapter.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function normalizePhase(agentSession: AgentSession, activeOperation: boolean): SessionPhase {
	if (agentSession.isCompacting) return "compaction";
	if (activeOperation || agentSession.isStreaming) return "turn";
	return "idle";
}

/**
 * Trace capture must never change the Agent's execution result, but a lost
 * record has to be observable. Log a redacted, payload-free diagnostic.
 */
function reportTraceFailure(phase: "request" | "response", callIndex: number, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.warn(redact(`[llm-trace] ${phase} capture failed (callIndex=${callIndex}): ${message.slice(0, 200)}`));
}

/**
 * Only content-bearing incremental events count as generated output. `start`,
 * `*_start`, `*_end`, `done` and `error` mark boundaries/state, not new content;
 * an empty delta carries no generated token even when the event type is a delta.
 */
function isGenerationDelta(event: AssistantMessageEvent): boolean {
	return (
		(event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") &&
		typeof event.delta === "string" &&
		event.delta.length > 0
	);
}

/**
 * Adapter that owns one AgentSession lifetime and exposes it to the rest of
 * the server through the `PiSessionRuntime` boundary.
 */
export class CodingAgentPiSessionRuntime implements PiSessionRuntime {
	readonly ephemeral: boolean;
	private readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	private activeOperation = false;
	private unsubscribeAgent: (() => void) | undefined;
	private unsubscribeQueue: (() => void) | undefined;
	private readonly agentSession: AgentSession;
	private readonly onDisposed: (() => void) | undefined;
	private disposed = false;
	/**
	 * Monotonic across every prompt on this runtime instance. The WIP used a
	 * per-`prompt()` local counter, which collided with the 0030 primary key
	 * `(turn_id, call_index)` on a second prompt in the same Turn and silently
	 * dropped records. Never reset it here; the Turn id is part of the key.
	 */
	private llmCallCounter = 0;

	constructor(agentSession: AgentSession, onDisposed?: () => void, ephemeral = false) {
		this.agentSession = agentSession;
		this.onDisposed = onDisposed;
		this.ephemeral = ephemeral;
		this.unsubscribeAgent = subscribeToAgentSession(agentSession, (progress) => {
			this.emitProgress(progress);
		});
		// Mirror queue updates as snapshot ticks so the UI can show pending
		// steering messages without waiting for a turn boundary.
		this.unsubscribeQueue = agentSession.subscribe((event) => {
			if (event.type === "queue_update" && event.steering.length > 0) {
				this.emitSnapshot();
			}
		});
	}

	get session(): AgentSession {
		return this.agentSession;
	}

	snapshot(): SessionSnapshot {
		const hints: RuntimeHints = {
			model: this.currentModelRef(),
			thinkingLevel: this.agentSession.thinkingLevel,
			phase: normalizePhase(this.agentSession, this.activeOperation),
		};
		return buildSessionSnapshot(this.agentSession.sessionManager, hints);
	}

	getPhase(): SessionPhase {
		return normalizePhase(this.agentSession, this.activeOperation);
	}

	async prompt(input: PromptInput): Promise<void> {
		// Structured history (if any) is injected into the native session before
		// this turn so the model request contains real assistant(toolCall) +
		// toolResult turns rather than flattened retrieval text.
		let preSeed: Promise<void> = Promise.resolve();
		if (input.transcript && input.transcript.length > 0) {
			const model = this.agentSession.model;
			const messages = toAgentMessages(input.transcript, {
				provider: model?.provider,
				model: model?.id,
				now: Date.now(),
			});
			preSeed = this.agentSession.injectTranscript(messages as never);
		}
		await this.runOperation(async () => {
			await preSeed;
			const attachments = this.attachmentOptions(input.attachments);
			const contextBlocks = this.contextBlocks(input.retrieval);
			const originalStream = this.agentSession.agent.streamFunction;
			if (input.onLlmTrace) {
				this.agentSession.agent.streamFunction = async (model, context, options) => {
					const index = ++this.llmCallCounter;
					const modelRef = { provider: model.provider, id: model.id };
					try {
						await input.onLlmTrace?.({ kind: "request", callIndex: index, model: modelRef, context });
					} catch (error) {
						// Diagnostics must not stop the model call, but the failure must be visible.
						reportTraceFailure("request", index, error);
					}
					// Timing starts immediately before the provider call, excluding
					// diagnostic-callback overhead. The monotonic sample is used only
					// for the duration; wall-clock stamps are observations for display.
					const startedAtMs = Date.now();
					const monotonicStartMs = performance.now();
					const stream = await originalStream(model, context, options);
					let recorded = false;
					let firstOutputAtMs: number | undefined;
					return new Proxy(stream, {
						get(target, property) {
							if (property === Symbol.asyncIterator) {
								// Observe the events the agent loop already consumes — never
								// start a second iterator or touch `result()` here. The wrapper
								// yields in the original order and preserves early return/throw.
								return () => {
									const iterator = target[Symbol.asyncIterator]();
									return {
										async next(...args: [] | [unknown]) {
											const step = await iterator.next(...args);
											if (!step.done && firstOutputAtMs === undefined && isGenerationDelta(step.value)) {
												firstOutputAtMs = performance.now();
											}
											return step;
										},
										async return(value?: unknown) {
											return iterator.return === undefined
												? ({ done: true, value } as IteratorResult<AssistantMessageEvent>)
												: iterator.return(value as never);
										},
										async throw(error?: unknown) {
											if (iterator.throw === undefined) throw error;
											return iterator.throw(error as never);
										},
										[Symbol.asyncIterator]() {
											return this;
										},
									};
								};
							}
							if (property === "result")
								return async () => {
									// `result()` settles when the stream has been fully
									// consumed, so timing here covers the whole response
									// lifecycle rather than only stream construction.
									const message = await target.result();
									if (!recorded) {
										recorded = true;
										const endedAtMs = Date.now();
										const timing = {
											startedAtMs,
											endedAtMs,
											durationMs: performance.now() - monotonicStartMs,
											...(firstOutputAtMs === undefined
												? {}
												: { firstOutputLatencyMs: firstOutputAtMs - monotonicStartMs }),
										};
										try {
											await input.onLlmTrace?.({
												kind: "response",
												callIndex: index,
												model: modelRef,
												message,
												timing,
											});
										} catch (error) {
											// Diagnostics must not change the provider result.
											reportTraceFailure("response", index, error);
										}
									}
									return message;
								};
							const value: unknown = Reflect.get(target, property, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
				};
			}
			try {
				await this.agentSession.prompt(input.text, {
					...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
					...(attachments ? { attachments } : {}),
					...(contextBlocks ? { contextBlocks } : {}),
				});
			} finally {
				this.agentSession.agent.streamFunction = originalStream;
			}
		});
	}

	async steer(input: SteerInput): Promise<void> {
		await this.runOperation(() =>
			this.agentSession.steer(
				input.text,
				undefined,
				this.attachmentOptions(input.attachments),
				this.contextBlocks(input.retrieval),
			),
		);
	}

	private attachmentOptions(
		attachments: readonly ResolvedAttachmentInput[] | undefined,
	): AttachmentInput[] | undefined {
		if (!attachments || attachments.length === 0) return undefined;
		return attachments.map(({ id, name, mediaType, path }) => ({ id, name, mediaType, path }));
	}

	/** Convert server-side retrieval into transcript-safe context blocks. */
	private contextBlocks(retrieval: PromptInput["retrieval"]): PromptContextBlock[] | undefined {
		if (!retrieval) return undefined;
		return [{ text: retrieval.context, reference: retrieval.reference }];
	}

	async abort(): Promise<void> {
		await this.runOperation(() => this.agentSession.abort());
	}

	async setModel(model: ModelRef): Promise<void> {
		await this.runOperation(async () => {
			const current = this.agentSession.model;
			if (current && current.provider === model.provider && current.id === model.id) {
				await this.agentSession.setModel(current);
				return;
			}
			const resolved = this.resolveModel(model);
			if (!resolved) {
				throw new PiServerError("not_found", `Model not available: ${model.provider}/${model.id}`);
			}
			await this.agentSession.setModel(resolved as Parameters<AgentSession["setModel"]>[0]);
		});
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		if (!THINKING_LEVELS.has(thinkingLevel)) {
			throw new PiServerError("invalid_request", `Unknown thinking level: ${thinkingLevel}`);
		}
		await this.runOperation(async () => {
			await this.agentSession.setThinkingLevel(thinkingLevel);
		});
	}

	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribeAgent?.();
		this.unsubscribeAgent = undefined;
		this.unsubscribeQueue?.();
		this.unsubscribeQueue = undefined;
		try {
			this.agentSession.dispose();
		} catch (error) {
			this.emitError(error);
		}
		this.listeners.clear();
		this.onDisposed?.();
	}

	private async runOperation(operation: () => Promise<void>): Promise<void> {
		if (this.disposed) throw new PiServerError("invalid_request", "Runtime is disposed");
		this.activeOperation = true;
		try {
			await operation();
		} catch (error) {
			if (error instanceof PiServerError) throw error;
			throw new PiServerError("invalid_request", error instanceof Error ? error.message : String(error));
		} finally {
			this.activeOperation = false;
			this.emitSnapshot();
		}
	}

	private emitProgress(progress: TranscriptProgress): void {
		for (const listener of this.listeners) {
			try {
				listener({ type: "progress", progress });
			} catch (error) {
				this.emitError(error);
			}
		}
	}

	private emitSnapshot(): void {
		for (const listener of this.listeners) {
			try {
				listener({ type: "snapshot" });
			} catch (error) {
				this.emitError(error);
			}
		}
	}

	private emitError(error: unknown): void {
		const wrapped =
			error instanceof PiServerError
				? error
				: new PiServerError("invalid_request", error instanceof Error ? error.message : String(error));
		for (const listener of this.listeners) {
			try {
				listener({ type: "error", error: wrapped });
			} catch {
				// Listener errors cannot escalate further.
			}
		}
	}

	private currentModelRef(): ModelRef | undefined {
		const model = this.agentSession.model;
		if (!model) return undefined;
		return { provider: model.provider, id: model.id };
	}

	private resolveModel(model: ModelRef): unknown {
		const runtime = (
			this.agentSession as unknown as {
				modelRuntime?: { getModel(provider: string, id: string): unknown };
			}
		).modelRuntime;
		if (!runtime) return undefined;
		return runtime.getModel(model.provider, model.id);
	}
}
