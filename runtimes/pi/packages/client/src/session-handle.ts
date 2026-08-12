import type {
	AttachmentScope,
	Command,
	LiveSpeechJob,
	LiveSpeechRequest,
	ModelRef,
	PromptResult,
	ResultForCommand,
	ServerEvent,
	SessionSnapshot,
	SteerResult,
	ThinkingLevel,
} from "@earendil-works/pi-protocol";
import type { Unsubscribe } from "./types.ts";

type SessionCommand = Extract<Command, { sessionId: string }>;

export type SessionLeaseMode = "shared" | "exclusive";

export interface AcquireSessionOptions {
	mode: SessionLeaseMode;
}

/** Optional payload for prompt/steer, e.g. ready attachments bound to the session. */
export interface SessionPromptOptions {
	attachmentIds?: string[];
	/**
	 * Phase 2 live朗读 opt-in. Only carried by `prompt`; `steer` deliberately
	 * ignores this field (V5 task §5.4 / Spec §7.6). The server is the only
	 * legitimate creator of the returned {@link LiveSpeechJob}; the client
	 * auto-registers any non-terminal job into the connection-scoped handle map.
	 */
	speech?: LiveSpeechRequest;
}

export interface SessionLease extends AsyncDisposable {
	readonly id: string;
	readonly active: boolean;
	readonly attached: boolean;
	readonly snapshot: SessionSnapshot | undefined;
	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe;
	onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
	detach(): Promise<void>;
	dispose(): Promise<void>;
	/**
	 * Send a prompt and (when `options.speech` is set) request a Phase 2
	 * live朗读 job. The returned `PromptResult.session` is always present;
	 * `liveSpeech` is only present when the server actually issued a job.
	 */
	prompt(text: string, options?: SessionPromptOptions): Promise<PromptResult>;
	steer(text: string, options?: SessionPromptOptions): Promise<SteerResult>;
	abort(): Promise<SessionSnapshot>;
	setModel(model: ModelRef): Promise<SessionSnapshot>;
	setThinking(thinkingLevel: ThinkingLevel): Promise<SessionSnapshot>;
	attachUpload(uploadId: string, scope: AttachmentScope): Promise<SessionSnapshot>;
	removeAttachment(attachmentId: string): Promise<SessionSnapshot>;
}

export type PiSessionHandle = SessionLease;

/** Re-exported for callers that only want the prompt result shape. */
export type { PromptResult, LiveSpeechJob };

export interface SessionHandleCallbacks {
	isAttached(): boolean;
	getSnapshot(): SessionSnapshot | undefined;
	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe;
	onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
	detach(): Promise<void>;
	dispose(): Promise<void>;
	request<const TCommand extends SessionCommand>(command: TCommand): Promise<ResultForCommand<TCommand>>;
}

export class SessionHandle implements SessionLease {
	readonly id: string;
	readonly #callbacks: SessionHandleCallbacks;

	constructor(id: string, callbacks: SessionHandleCallbacks) {
		this.id = id;
		this.#callbacks = callbacks;
	}

	get attached(): boolean {
		return this.#callbacks.isAttached();
	}

	get active(): boolean {
		return this.attached;
	}

	get snapshot(): SessionSnapshot | undefined {
		return this.#callbacks.getSnapshot();
	}

	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe {
		return this.#callbacks.subscribe(listener);
	}

	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		return this.#callbacks.onEvent(listener);
	}

	async detach(): Promise<void> {
		await this.#callbacks.detach();
	}

	dispose(): Promise<void> {
		return this.#callbacks.dispose();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	async prompt(text: string, options?: SessionPromptOptions): Promise<PromptResult> {
		const command: Command = {
			command: "prompt",
			sessionId: this.id,
			text,
			...(options?.attachmentIds ? { attachmentIds: options.attachmentIds } : {}),
			// Phase 2 live朗读 opt-in is intentionally attached even when its
			// value is undefined so future spec changes remain explicit; the
			// protocol layer drops the key via `Type.Optional`.
			...(options?.speech ? { speech: options.speech } : {}),
		};
		return this.#request(command);
	}

	async steer(text: string, options?: SessionPromptOptions): Promise<SteerResult> {
		const command: Command = {
			command: "steer",
			sessionId: this.id,
			text,
			...(options?.attachmentIds ? { attachmentIds: options.attachmentIds } : {}),
		};
		return this.#request(command);
	}

	async abort(): Promise<SessionSnapshot> {
		return (await this.#request({ command: "abort", sessionId: this.id })).session;
	}

	async setModel(model: ModelRef): Promise<SessionSnapshot> {
		return (await this.#request({ command: "set_model", sessionId: this.id, model })).session;
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<SessionSnapshot> {
		return (await this.#request({ command: "set_thinking", sessionId: this.id, thinkingLevel })).session;
	}

	async attachUpload(uploadId: string, scope: AttachmentScope): Promise<SessionSnapshot> {
		return (await this.#request({ command: "attach_upload", sessionId: this.id, uploadId, scope })).session;
	}

	async removeAttachment(attachmentId: string): Promise<SessionSnapshot> {
		return (await this.#request({ command: "remove_attachment", sessionId: this.id, attachmentId })).session;
	}

	#request<const TCommand extends SessionCommand>(command: TCommand): Promise<ResultForCommand<TCommand>> {
		return this.#callbacks.request(command);
	}
}
