/**
 * Deferred-header PCM sink for the V8 live coordinator.
 *
 * The browser claims the live stream over HTTP *after* the job is created and
 * the first utterance may already be synthesizing. This sink bridges that gap:
 * before the response is attached it parks writes (the queue's `write` promise
 * stays pending → upstream backpressure); once the HTTP handler attaches the
 * response, parked writes drain in order, headers are written on the first
 * PCM byte, and the stream proceeds with `drain`-based backpressure.
 *
 * Terminal contract (frozen by V8):
 *
 * - `close` on a job that never wrote headers → `204 No Content` (the
 *   "no speakable text" case); with headers → clean `end()`.
 * - `fail` before headers → `502` JSON error body; after headers → `destroy()`.
 * - Both are idempotent; a downstream close before a clean `end()` cancels the
 *   job via `onDownstreamClosed`.
 */

import type { ServerResponse } from "node:http";
import type { LiveSpeechErrorCode } from "@earendil-works/pi-protocol";
import { errorBody } from "../../web/http-shared.ts";
import type { VoiceAudioFormat } from "../types.ts";
import type { PcmSink } from "./utterance-queue.ts";

export interface PendingPcmSinkOptions {
	/** The run's abort signal; parked writes reject when it fires. */
	signal: AbortSignal;
	/** Job id, surfaced as `x-pi-live-speech-job-id`. */
	jobId: string;
	/** Called the first time a PCM byte is written to the response. */
	onFirstByte: () => void;
	/** Called for every forwarded chunk (used for the %4 final-length check). */
	onBytes: (bytes: number) => void;
	/** Called when the browser closes the response before a clean end. */
	onDownstreamClosed: () => void;
}

type SinkState = "parked" | "active" | "closed" | "failed";

interface ParkedWrite {
	chunk: Uint8Array;
	signal: AbortSignal;
	resolve: () => void;
	reject: (error: Error) => void;
}

export class PendingPcmSink implements PcmSink {
	private readonly options: PendingPcmSinkOptions;
	private state: SinkState = "parked";
	private format: VoiceAudioFormat | undefined;
	private response: ServerResponse | undefined;
	private headersWritten = false;
	private parked: ParkedWrite | undefined;
	private wantsClose = false;
	private wantsFail: { code: LiveSpeechErrorCode; message: string } | undefined;
	private onAbort: (() => void) | undefined;

	constructor(options: PendingPcmSinkOptions) {
		this.options = options;
		// Release any parked write when the run aborts so the queue's
		// `streamEntry` observes `settled` instead of hanging forever.
		if (options.signal.aborted) {
			this.releaseParked(new DOMException("Aborted", "AbortError"));
		} else {
			this.onAbort = () => this.releaseParked(new DOMException("Aborted", "AbortError"));
			options.signal.addEventListener("abort", this.onAbort, { once: true });
		}
	}

	/** The queue reports the frozen format before the first `write`. */
	setFormat(format: VoiceAudioFormat): void {
		this.format = format;
	}

	/** The HTTP handler attaches the claimed browser response. Idempotent. */
	attach(response: ServerResponse): void {
		if (this.response) return;
		this.response = response;
		response.once("close", () => {
			// A clean `end()` has `writableEnded === true`; only an early close
			// (browser disconnect) cancels the job.
			if (!response.writableEnded) this.options.onDownstreamClosed();
		});
		this.state = this.state === "closed" ? "closed" : this.state === "failed" ? "failed" : "active";
		if (this.parked) {
			const parked = this.parked;
			this.parked = undefined;
			parked.resolve();
		}
		if (this.wantsClose) {
			this.wantsClose = false;
			this.applyClose();
		} else if (this.wantsFail) {
			const error = this.wantsFail;
			this.wantsFail = undefined;
			this.applyFail(error);
		}
	}

	async write(chunk: Uint8Array, signal: AbortSignal): Promise<void> {
		if (this.isTerminal()) {
			throw new DOMException("Sink is closed", "AbortError");
		}
		if (signal.aborted) {
			throw new DOMException("Aborted", "AbortError");
		}
		if (this.response === undefined) {
			// Pre-claim backpressure: park this write until the browser claims.
			await this.park(chunk, signal);
			if (signal.aborted) throw new DOMException("Aborted", "AbortError");
		}
		// The state may have changed while parked (attach/close/fail).
		if (this.isTerminal()) {
			throw new DOMException("Sink is closed", "AbortError");
		}
		const response = this.response;
		if (!response || response.destroyed) {
			throw new DOMException("Response is closed", "AbortError");
		}
		if (!this.headersWritten) {
			this.writeHeaders(response);
			this.options.onFirstByte();
		}
		await this.forward(response, chunk, signal);
		if (!response.destroyed) this.options.onBytes(chunk.byteLength);
	}

	private isTerminal(): boolean {
		return this.state === "closed" || this.state === "failed";
	}

	async close(_signal: AbortSignal): Promise<void> {
		if (this.isTerminal()) return;
		this.state = "closed";
		this.applyClose();
	}

	async fail(error: { code: LiveSpeechErrorCode; message: string }, _signal: AbortSignal): Promise<void> {
		if (this.isTerminal()) return;
		this.state = "failed";
		this.applyFail(error);
	}

	/**
	 * Apply a deferred or immediate close. Safe to call before the response is
	 * attached (it is remembered as `wantsClose`) and from `attach`.
	 */
	private applyClose(): void {
		if (!this.response) {
			this.wantsClose = true;
			return;
		}
		this.cleanupListeners();
		const response = this.response;
		if (response.destroyed) return;
		if (!this.headersWritten) {
			// No speakable text was ever produced.
			response.writeHead(204);
			response.end();
			return;
		}
		if (!response.writableEnded) response.end();
	}

	/**
	 * Apply a deferred or immediate failure. Safe to call before the response is
	 * attached (it is remembered as `wantsFail`) and from `attach`.
	 */
	private applyFail(error: { code: LiveSpeechErrorCode; message: string }): void {
		if (!this.response) {
			this.wantsFail = error;
			return;
		}
		this.cleanupListeners();
		const response = this.response;
		if (response.destroyed) return;
		if (!this.headersWritten) {
			// Pre-first-byte failure: the browser can still read a JSON error.
			errorBody(response, { status: 502, code: error.code, message: error.message });
			return;
		}
		response.destroy();
	}

	private park(chunk: Uint8Array, signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (this.response) {
				resolve();
				return;
			}
			if (signal.aborted) {
				reject(new DOMException("Aborted", "AbortError"));
				return;
			}
			const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
			signal.addEventListener("abort", onAbort, { once: true });
			this.parked = {
				chunk,
				signal,
				resolve: () => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				},
				reject: (error: Error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			};
		});
	}

	/** Reject the parked write (run aborted) so the queue loop can observe it. */
	private releaseParked(error: Error): void {
		const parked = this.parked;
		if (parked) {
			this.parked = undefined;
			parked.reject(error);
		}
	}

	private writeHeaders(response: ServerResponse): void {
		const format = this.format;
		response.writeHead(200, {
			"content-type": "application/vnd.pi.pcm",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"x-pi-live-speech-job-id": this.options.jobId,
			"x-pi-audio-encoding": format?.encoding ?? "pcm_f32le",
			"x-pi-audio-sample-rate": String(format?.sampleRate ?? 0),
			"x-pi-audio-channels": String(format?.channels ?? 1),
			"access-control-expose-headers":
				"X-Pi-Live-Speech-Job-Id, X-Pi-Audio-Encoding, X-Pi-Audio-Sample-Rate, X-Pi-Audio-Channels",
		});
		this.headersWritten = true;
	}

	private async forward(response: ServerResponse, chunk: Uint8Array, signal: AbortSignal): Promise<void> {
		if (response.write(chunk)) return;
		// Backpressure: resolve on drain OR close/abort so the queue loop
		// re-checks its own abort state instead of hanging forever.
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				response.off("drain", onDrain);
				response.off("close", onClose);
				signal.removeEventListener("abort", onAbort);
				resolve();
			};
			const onDrain = finish;
			const onClose = finish;
			const onAbort = finish;
			response.once("drain", onDrain);
			response.once("close", onClose);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	private cleanupListeners(): void {
		if (this.onAbort) {
			this.options.signal.removeEventListener("abort", this.onAbort);
			this.onAbort = undefined;
		}
		this.releaseParked(new DOMException("Aborted", "AbortError"));
	}
}
