import { type MicrophonePcmCapture, openMicrophonePcmCapture } from "./microphone-pcm-capture.ts";

export type VoiceAsrPhase = "idle" | "requesting_permission" | "listening" | "final" | "error";

export interface VoiceAsrState {
	readonly phase: VoiceAsrPhase;
	readonly finalRequestId?: string;
	readonly finalText?: string;
	readonly error?: string;
}

export interface VoiceAsrSessionOptions {
	readonly send: (frame: string) => boolean;
	readonly onState: (state: VoiceAsrState) => void;
	readonly openCapture?: () => Promise<MicrophonePcmCapture>;
	readonly createRequestId?: () => string;
}

/** Owns one VoxEMW ASR request and its microphone lifecycle; it never creates a Turn. */
export class VoiceAsrSession {
	private readonly options: VoiceAsrSessionOptions;
	private capture: MicrophonePcmCapture | undefined;
	private requestId: string | undefined;
	private sequence = 0;
	private generation = 0;
	private disposed = false;

	constructor(options: VoiceAsrSessionOptions) {
		this.options = options;
	}

	get active(): boolean {
		return this.requestId !== undefined || this.capture !== undefined;
	}

	async start(): Promise<void> {
		if (this.disposed) return;
		await this.cancel();
		const generation = ++this.generation;
		this.options.onState({ phase: "requesting_permission" });
		try {
			const capture = await (this.options.openCapture ?? openMicrophonePcmCapture)();
			if (this.disposed || generation !== this.generation) {
				await capture.stop();
				return;
			}
			const requestId = this.options.createRequestId?.() ?? `asr_${crypto.randomUUID()}`;
			if (!this.options.send(JSON.stringify({ type: "asr.start", request_id: requestId }))) {
				await capture.stop();
				this.options.onState({ phase: "error", error: "语音连接不可用" });
				return;
			}
			this.capture = capture;
			this.requestId = requestId;
			this.sequence = 0;
			capture.start((pcm) => this.sendAudio(requestId, pcm));
			this.options.onState({ phase: "listening" });
		} catch (error) {
			if (generation !== this.generation || this.disposed) return;
			const message = microphoneError(error);
			await this.cancel();
			this.options.onState({ phase: "error", error: message });
		}
	}

	handleMessage(data: string): void {
		let event: unknown;
		try {
			event = JSON.parse(data);
		} catch {
			return;
		}
		if (!isRecord(event) || typeof event.type !== "string") return;
		if (event.type === "asr.final" && event.request_id === this.requestId && typeof event.text === "string") {
			const finalRequestId = this.requestId;
			this.requestId = undefined;
			void this.stopCapture();
			this.options.onState({ phase: "final", finalRequestId, finalText: event.text });
			return;
		}
		if (event.type === "asr.cancelled" && event.request_id === this.requestId) {
			this.requestId = undefined;
			void this.stopCapture();
			this.options.onState({ phase: "idle" });
			return;
		}
		if (event.type === "error" && (event.scope === "connection" || event.request_id === this.requestId)) {
			this.requestId = undefined;
			void this.stopCapture();
			this.options.onState({
				phase: "error",
				error: typeof event.message === "string" ? event.message : "语音识别失败",
			});
		}
	}

	async cancel(): Promise<void> {
		this.generation += 1;
		const requestId = this.requestId;
		this.requestId = undefined;
		if (requestId !== undefined) {
			this.options.send(JSON.stringify({ type: "asr.cancel", request_id: requestId }));
		}
		await this.stopCapture();
	}

	async handleDisconnect(): Promise<void> {
		this.generation += 1;
		this.requestId = undefined;
		await this.stopCapture();
		if (!this.disposed) this.options.onState({ phase: "error", error: "语音连接已断开" });
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		await this.cancel();
		this.disposed = true;
	}

	private sendAudio(requestId: string, pcm: Uint8Array): void {
		if (requestId !== this.requestId) return;
		const audio = bytesToBase64(pcm);
		const sent = this.options.send(
			JSON.stringify({ type: "asr.audio", request_id: requestId, sequence: this.sequence, audio }),
		);
		if (sent) this.sequence += 1;
		else void this.handleDisconnect();
	}

	private async stopCapture(): Promise<void> {
		const capture = this.capture;
		this.capture = undefined;
		if (capture !== undefined) {
			try {
				await capture.stop();
			} catch {
				// Tracks/nodes are best-effort idempotent during browser teardown.
			}
		}
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function microphoneError(error: unknown): string {
	if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
		return "麦克风权限被拒绝";
	}
	return error instanceof Error && error.message ? error.message : "无法启动麦克风";
}
