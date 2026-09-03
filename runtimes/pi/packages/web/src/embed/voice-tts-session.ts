import { type Pcm16Player, WebAudioPcm16Player } from "./pcm16-playback.ts";
import { filterSpeechContent } from "./speech-content-filter.ts";
import { VoiceSentenceBuffer } from "./voice-sentence-buffer.ts";

export interface VoiceTtsSessionOptions {
	readonly send: (frame: string) => boolean;
	readonly player?: Pcm16Player;
	readonly createRequestId?: () => string;
	readonly onPhase?: (phase: VoiceTtsPhase) => void;
}

export type VoiceTtsPhase = "idle" | "synthesizing" | "playing" | "error";

export type VisibleAssistantStatus = "streaming" | "complete" | "other";

export function currentVisibleAssistant(
	messages: readonly {
		readonly id?: string;
		readonly role: string;
		readonly text: string;
		readonly streaming?: boolean;
		readonly thinking?: string;
		readonly tools?: readonly unknown[];
	}[],
): { readonly id: string | undefined; readonly text: string; readonly status: VisibleAssistantStatus } {
	let assistant = messages.at(-1);
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "assistant") {
			assistant = messages[index];
			break;
		}
	}
	if (assistant?.role !== "assistant") assistant = undefined;
	return {
		id: assistant?.id,
		text: assistant?.text ?? "",
		status: assistant === undefined ? "other" : assistant.streaming ? "streaming" : "complete",
	};
}

/** Serial sentence synthesis and ordered PCM playback over the existing Voice WS. */
export class VoiceTtsSession {
	private readonly options: VoiceTtsSessionOptions;
	private readonly player: Pcm16Player;
	private readonly buffer = new VoiceSentenceBuffer();
	private readonly queue: string[] = [];
	private activeRequestId: string | undefined;
	private expectedAudioSequence = 0;
	private readonly pendingAudio = new Map<number, Uint8Array>();
	private enabled = false;
	private observedId: string | undefined;
	private observedText = "";
	private observedStatus: VisibleAssistantStatus = "other";
	private suppressActiveAudio = false;
	private playbackMayBeActive = false;
	private playbackReset: Promise<void> | undefined;

	constructor(options: VoiceTtsSessionOptions) {
		this.options = options;
		this.player = options.player ?? new WebAudioPcm16Player();
	}

	enable(): void {
		this.enabled = true;
		this.player.prepare();
		this.options.onPhase?.("idle");
	}

	/** Feed only the already-rendered assistant text projection, never thinking/tools. */
	observeVisibleAssistant(id: string | undefined, text: string, status: VisibleAssistantStatus): void {
		const speakableText = filterSpeechContent(text);
		if (!this.enabled) {
			this.setObserved(id, speakableText, status);
			return;
		}
		if (id === undefined) return;
		if (id !== this.observedId) {
			this.replacePreviousReply();
			this.setObserved(id, speakableText, status);
			this.enqueueSentences(this.buffer.push(speakableText));
			if (status === "complete") this.enqueueSentences(this.buffer.flush());
			return;
		}
		if (speakableText.startsWith(this.observedText)) {
			this.enqueueSentences(this.buffer.push(speakableText.slice(this.observedText.length)));
		} else {
			// A partial Markdown line can become a table/code construct as it
			// streams. Discard its unsent tail instead of reading stale markup.
			this.buffer.clear();
		}
		if (status === "complete" && this.observedStatus === "streaming") {
			this.enqueueSentences(this.buffer.flush());
		}
		this.setObserved(id, speakableText, status);
	}

	handleMessage(data: string): void {
		let event: unknown;
		try {
			event = JSON.parse(data);
		} catch {
			return;
		}
		if (!isRecord(event) || event.request_id !== this.activeRequestId) return;
		if (
			event.type === "tts.audio" &&
			!this.suppressActiveAudio &&
			typeof event.sequence === "number" &&
			Number.isSafeInteger(event.sequence) &&
			event.sequence >= 0 &&
			typeof event.audio === "string"
		) {
			const pcm = base64ToBytes(event.audio);
			if (pcm !== undefined && event.sequence >= this.expectedAudioSequence) {
				this.options.onPhase?.("playing");
				this.pendingAudio.set(event.sequence, pcm);
				this.drainAudio();
			}
			return;
		}
		if (event.type === "error") {
			this.options.onPhase?.("error");
			this.finishActive();
			return;
		}
		if (event.type === "tts.completed" || event.type === "tts.stopped") {
			this.finishActive();
		}
	}

	async stop(sendStop = true): Promise<void> {
		this.enabled = false;
		this.buffer.clear();
		this.queue.length = 0;
		const activeRequestId = this.activeRequestId;
		this.activeRequestId = undefined;
		this.pendingAudio.clear();
		this.expectedAudioSequence = 0;
		this.suppressActiveAudio = false;
		this.playbackMayBeActive = false;
		if (sendStop && activeRequestId !== undefined) {
			this.options.send(JSON.stringify({ type: "tts.stop", request_id: activeRequestId }));
		}
		await this.player.stop();
		this.options.onPhase?.("idle");
	}

	/** Stop stale speech for a new user turn without disabling future replies. */
	interruptForUserTurn(): void {
		if (this.enabled) this.replacePreviousReply();
	}

	private enqueueSentences(sentences: readonly string[]): void {
		this.queue.push(...sentences);
		this.pump();
	}

	private pump(): void {
		if (!this.enabled || this.activeRequestId !== undefined || this.playbackReset !== undefined) return;
		const text = this.queue.shift();
		if (text === undefined) return;
		const requestId = this.options.createRequestId?.() ?? `tts_${crypto.randomUUID()}`;
		if (!this.options.send(JSON.stringify({ type: "tts.synthesize", request_id: requestId, text }))) {
			this.queue.unshift(text);
			return;
		}
		this.activeRequestId = requestId;
		this.options.onPhase?.("synthesizing");
		this.expectedAudioSequence = 0;
		this.pendingAudio.clear();
		this.suppressActiveAudio = false;
	}

	private drainAudio(): void {
		let pcm = this.pendingAudio.get(this.expectedAudioSequence);
		while (pcm !== undefined) {
			this.pendingAudio.delete(this.expectedAudioSequence);
			this.expectedAudioSequence += 1;
			this.player.enqueue(pcm);
			this.playbackMayBeActive = true;
			pcm = this.pendingAudio.get(this.expectedAudioSequence);
		}
	}

	private finishActive(): void {
		this.activeRequestId = undefined;
		this.expectedAudioSequence = 0;
		this.pendingAudio.clear();
		this.pump();
		if (this.activeRequestId === undefined) this.options.onPhase?.("idle");
	}

	private replacePreviousReply(): void {
		this.buffer.clear();
		this.queue.length = 0;
		this.pendingAudio.clear();
		this.expectedAudioSequence = 0;
		const shouldResetPlayback =
			(this.activeRequestId !== undefined && !this.suppressActiveAudio) || this.playbackMayBeActive;
		if (!shouldResetPlayback) return;
		this.playbackMayBeActive = false;
		if (this.activeRequestId !== undefined && !this.suppressActiveAudio) {
			this.suppressActiveAudio = true;
			const sent = this.options.send(JSON.stringify({ type: "tts.stop", request_id: this.activeRequestId }));
			if (!sent) this.activeRequestId = undefined;
		}
		const reset = this.player.stop().then(() => {
			if (this.enabled) this.player.prepare();
			if (this.playbackReset === reset) this.playbackReset = undefined;
			this.pump();
		});
		this.playbackReset = reset;
	}

	private setObserved(id: string | undefined, text: string, status: VisibleAssistantStatus): void {
		this.observedId = id;
		this.observedText = text;
		this.observedStatus = status;
	}
}

function base64ToBytes(value: string): Uint8Array | undefined {
	try {
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		return bytes;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
