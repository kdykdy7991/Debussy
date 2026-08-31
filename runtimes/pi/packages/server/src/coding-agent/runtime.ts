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
import type { AgentSession, AttachmentInput, PromptContextBlock } from "@earendil-works/pi-coding-agent";
import type {
	ModelRef,
	SessionPhase,
	SessionSnapshot,
	ThinkingLevel,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";
import { PiServerError } from "../errors.ts";
import { toAgentMessages } from "./history-mapper.ts";
import type {
	PiSessionRuntime,
	PiSessionRuntimeEvent,
	PromptInput,
	ResolvedAttachmentInput,
	SteerInput,
} from "../types.ts";
import { subscribeToAgentSession } from "./progress-adapter.ts";
import { buildSessionSnapshot, type RuntimeHints } from "./snapshot-adapter.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function normalizePhase(agentSession: AgentSession, activeOperation: boolean): SessionPhase {
	if (agentSession.isCompacting) return "compaction";
	if (activeOperation || agentSession.isStreaming) return "turn";
	return "idle";
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
			return this.agentSession.prompt(input.text, {
				...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
				...(attachments ? { attachments } : {}),
				...(contextBlocks ? { contextBlocks } : {}),
			});
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
