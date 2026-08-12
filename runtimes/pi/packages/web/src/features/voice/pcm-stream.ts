/**
 * Raw PCM stream parsing for the Pi speech feature.
 *
 * The browser-facing speech route serves a continuous, mono, little-endian
 * IEEE-754 float32 body (`application/vnd.pi.pcm`). HTTP chunk boundaries are
 * unrelated to model chunk boundaries, so the parser must reassemble frames
 * across network chunks and survive 1/2/3 byte remainders. This module is pure
 * logic with no DOM dependency and can be tested headlessly.
 */

export type PcmStreamErrorCode = "invalid_format" | "non_finite_sample" | "truncated_stream";

export class PcmStreamError extends Error {
	readonly code: PcmStreamErrorCode;

	constructor(code: PcmStreamErrorCode, message: string) {
		super(message);
		this.name = "PcmStreamError";
		this.code = code;
	}
}

/** Structural subset of the protocol SpeechAudioFormat, without the protocol dependency. */
export interface PcmFormat {
	encoding: "pcm_f32le";
	sampleRate: number;
	channels: 1;
}

const SAMPLE_BYTES = 4;

/**
 * Validates audio metadata before decoding. The value comes from server headers,
 * so it is treated as untrusted input. The spec locks V3 to a single encoding
 * and channel count; anything else means the peer is not speaking the agreed
 * protocol and playback must fail fast rather than produce garbage.
 */
export function validatePcmFormat(value: unknown): PcmFormat {
	if (typeof value !== "object" || value === null) {
		throw new PcmStreamError("invalid_format", "Missing or invalid PCM format metadata");
	}
	const format = value as Record<string, unknown>;
	if (format.encoding !== "pcm_f32le") {
		throw new PcmStreamError("invalid_format", `Unsupported PCM encoding: ${String(format.encoding)}`);
	}
	if (typeof format.sampleRate !== "number" || !Number.isInteger(format.sampleRate) || format.sampleRate < 1) {
		throw new PcmStreamError("invalid_format", `Invalid PCM sample rate: ${String(format.sampleRate)}`);
	}
	if (format.channels !== 1) {
		throw new PcmStreamError("invalid_format", `Unsupported PCM channel count: ${String(format.channels)}`);
	}
	return { encoding: "pcm_f32le", sampleRate: format.sampleRate, channels: 1 };
}

/**
 * Incremental float32 decoder. Feed network chunks with {@link push}, drain
 * reassembled samples with {@link take}, and call {@link end} at EOF to verify
 * the stream ended on a frame boundary.
 */
export class PcmDecoder {
	#remainder: Uint8Array = new Uint8Array(0);
	#buffers: Float32Array[] = [];
	#queuedSamples = 0;

	/** Samples reassembled and decoded but not yet drained by {@link take}. */
	get queuedSamples(): number {
		return this.#queuedSamples;
	}

	/** Bytes buffered that are not yet a complete 4-byte sample frame. */
	get remainderBytes(): number {
		return this.#remainder.byteLength;
	}

	/**
	 * Consumes a network chunk, prepending any leftover bytes from the previous
	 * chunk. Throws {@link PcmStreamError} on a non-finite sample; the stream is
	 * corrupt at that point and should be failed, not patched.
	 */
	push(chunk: Uint8Array): void {
		if (chunk.byteLength === 0 && this.#remainder.byteLength === 0) return;
		const combined = this.#remainder.byteLength === 0 ? chunk : concatBytes(this.#remainder, chunk);
		const completeBytes = combined.byteLength - (combined.byteLength % SAMPLE_BYTES);
		const frames = completeBytes >> 2;
		if (frames > 0) {
			const decoded = decodeFloat32(combined, frames);
			this.#buffers.push(decoded);
			this.#queuedSamples += frames;
		}
		this.#remainder = combined.subarray(completeBytes);
	}

	/**
	 * Drains up to `limit` reassembled samples as a single contiguous array.
	 * Returns an empty array when nothing is queued.
	 */
	take(limit = Number.POSITIVE_INFINITY): Float32Array {
		if (this.#queuedSamples === 0) return new Float32Array(0);
		const count = Math.min(Math.max(0, Math.floor(limit)), this.#queuedSamples);
		if (count === 0) return new Float32Array(0);
		const result = new Float32Array(count);
		let written = 0;
		while (written < count) {
			const first = this.#buffers[0];
			const needed = count - written;
			if (first.length <= needed) {
				result.set(first, written);
				written += first.length;
				this.#buffers.shift();
			} else {
				result.set(first.subarray(0, needed), written);
				this.#buffers[0] = first.subarray(needed);
				written += needed;
			}
		}
		this.#queuedSamples -= count;
		return result;
	}

	/**
	 * Marks end-of-stream. Throws {@link PcmStreamError} when leftover bytes do
	 * not form a complete float32 frame, meaning the body was truncated.
	 */
	end(): void {
		if (this.#remainder.byteLength > 0) {
			throw new PcmStreamError(
				"truncated_stream",
				`PCM stream truncated: ${this.#remainder.byteLength} trailing byte(s)`,
			);
		}
	}
}

function decodeFloat32(bytes: Uint8Array, frames: number): Float32Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const decoded = new Float32Array(frames);
	for (let frame = 0; frame < frames; frame++) {
		const sample = view.getFloat32(frame * SAMPLE_BYTES, true);
		if (!Number.isFinite(sample)) {
			throw new PcmStreamError("non_finite_sample", `Non-finite PCM sample at frame ${frame}`);
		}
		decoded[frame] = sample > 1 ? 1 : sample < -1 ? -1 : sample;
	}
	return decoded;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	const combined = new Uint8Array(left.byteLength + right.byteLength);
	combined.set(left, 0);
	combined.set(right, left.byteLength);
	return combined;
}
