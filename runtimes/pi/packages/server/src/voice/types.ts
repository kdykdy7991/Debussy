import type { SpeechErrorCode } from "@earendil-works/pi-protocol";

/** A configured voice profile mapping a public id to provider parameters. */
export interface VoiceProfile {
	id: string;
	name?: string;
	provider: "qwen3-tts";
	language: string;
	speaker: string;
	instruct?: string;
}

/** Public identity surfaced to clients; provider internals never cross the wire. */
export interface VoiceProfileSummary {
	id: string;
	name?: string;
}

/** Snapshot capability advertised only when the server has a speech proxy. */
export interface VoiceCapability {
	available: true;
	/** Phase 2 live朗读 capability; `false` until the V8 coordinator ships. */
	live: boolean;
	defaultProfile: string;
	profiles?: VoiceProfileSummary[];
}

/** PCM metadata validated from the upstream Voice Service response. */
export interface VoiceAudioFormat {
	encoding: "pcm_f32le";
	sampleRate: number;
	channels: 1;
}

/** The profile-resolved synthesis parameters sent to the Voice Service. */
export interface StreamSynthesisRequest {
	text: string;
	language: string;
	speaker: string;
	instruct?: string;
	chunkSize?: number;
}

/** An open, validated streaming PCM response from the Voice Service. */
export interface VoiceStreamResult {
	format: VoiceAudioFormat;
	/** Limited, never fully buffered; enforces idle/total/max-byte limits. */
	body: ReadableStream<Uint8Array>;
}

export interface VoiceServiceClient {
	/**
	 * Open a streaming synthesis. The first PCM chunk is awaited here so the
	 * first-chunk timeout can be enforced before any browser headers are written.
	 */
	openStream(request: StreamSynthesisRequest, signal: AbortSignal): Promise<VoiceStreamResult>;
}

/** Upstream unavailable or protocol-invalid before the first PCM byte (maps to 502). */
export class VoiceUpstreamError extends Error {
	readonly code: SpeechErrorCode = "voice_unavailable";
	constructor(message: string) {
		super(message);
		this.name = "VoiceUpstreamError";
	}
}

/** A stream that exceeded a configured limit (maps to `speech_generation_failed`). */
export class VoiceLimitError extends Error {
	readonly reason: "idle_timeout" | "total_timeout" | "max_bytes";
	constructor(reason: "idle_timeout" | "total_timeout" | "max_bytes", message: string) {
		super(message);
		this.name = "VoiceLimitError";
		this.reason = reason;
	}
}
