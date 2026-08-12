import type {
	CancelLiveSpeechCommand,
	CancelLiveSpeechResult,
	CancelSpeechCommand,
	CancelSpeechResult,
	LiveSpeechJob,
	LiveSpeechStatus,
	SpeechJob,
	SpeechStatus,
} from "@earendil-works/pi-protocol";
import { toError } from "./errors.ts";
import type { ListenerErrorHandler, LiveSpeechJobHandle, SpeechJobHandle, Unsubscribe } from "./types.ts";

const TERMINAL_STATUSES = new Set<SpeechStatus>(["completed", "failed", "cancelled"]);

export function isSpeechTerminal(status: SpeechStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

const LIVE_TERMINAL_STATUSES = new Set<LiveSpeechStatus>(["completed", "cancelled", "failed"]);

export function isLiveSpeechTerminal(status: LiveSpeechStatus): boolean {
	return LIVE_TERMINAL_STATUSES.has(status);
}

export interface SpeechJobHandleDeps {
	cancel(command: CancelSpeechCommand): Promise<CancelSpeechResult>;
	onListenerError?: ListenerErrorHandler;
}

/**
 * Control-plane handle for one speech job. State advances arrive over the
 * `speech_job` event, which the PiClient routes to the owning connection only.
 */
export class SpeechJobHandleImpl implements SpeechJobHandle {
	readonly #cancel: (command: CancelSpeechCommand) => Promise<CancelSpeechResult>;
	readonly #onListenerError: ListenerErrorHandler | undefined;
	readonly #listeners = new Set<(job: SpeechJob) => void>();
	#job: SpeechJob;

	constructor(job: SpeechJob, deps: SpeechJobHandleDeps) {
		this.#job = job;
		this.#cancel = deps.cancel;
		this.#onListenerError = deps.onListenerError;
	}

	get job(): SpeechJob {
		return this.#job;
	}

	subscribe(listener: (job: SpeechJob) => void): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async cancel(): Promise<SpeechJob> {
		const result = await this.#cancel({ command: "cancel_speech", jobId: this.#job.id });
		this.apply(result.job);
		return this.#job;
	}

	/** Applies a server-reported job advance, guarding against reordering and terminal regressions. */
	apply(job: SpeechJob): void {
		if (this.#isStale(job)) return;
		this.#job = job;
		for (const listener of this.#listeners) {
			try {
				listener(job);
			} catch (error) {
				this.#reportListenerError(error);
			}
		}
	}

	#isStale(next: SpeechJob): boolean {
		if (next.updatedAt < this.#job.updatedAt) return true;
		if (isSpeechTerminal(this.#job.status) && !isSpeechTerminal(next.status)) return true;
		return false;
	}

	#reportListenerError(error: unknown): void {
		if (!this.#onListenerError) return;
		try {
			this.#onListenerError(toError(error));
		} catch {
			// Diagnostics cannot affect job state.
		}
	}
}

export interface LiveSpeechJobHandleDeps {
	cancel(command: CancelLiveSpeechCommand): Promise<CancelLiveSpeechResult>;
	onListenerError?: ListenerErrorHandler;
}

/**
 * Control-plane handle for one Phase 2 live朗读 job. Mirrors the Phase 1
 * `SpeechJobHandleImpl` shape so V8/V9 can swap implementations without
 * changing the consumer surface. Terminal statuses (`completed`, `cancelled`,
 * `failed`) are irreversible.
 */
export class LiveSpeechJobHandleImpl implements LiveSpeechJobHandle {
	readonly #cancel: (command: CancelLiveSpeechCommand) => Promise<CancelLiveSpeechResult>;
	readonly #onListenerError: ListenerErrorHandler | undefined;
	readonly #listeners = new Set<(job: LiveSpeechJob) => void>();
	#job: LiveSpeechJob;

	constructor(job: LiveSpeechJob, deps: LiveSpeechJobHandleDeps) {
		this.#job = job;
		this.#cancel = deps.cancel;
		this.#onListenerError = deps.onListenerError;
	}

	get job(): LiveSpeechJob {
		return this.#job;
	}

	subscribe(listener: (job: LiveSpeechJob) => void): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async cancel(): Promise<LiveSpeechJob> {
		const result = await this.#cancel({ command: "cancel_live_speech", jobId: this.#job.id });
		this.apply(result.job);
		return this.#job;
	}

	/** Applies a server-reported job advance, guarding against reordering and terminal regressions. */
	apply(job: LiveSpeechJob): void {
		if (this.#isStale(job)) return;
		this.#job = job;
		for (const listener of this.#listeners) {
			try {
				listener(job);
			} catch (error) {
				this.#reportListenerError(error);
			}
		}
	}

	#isStale(next: LiveSpeechJob): boolean {
		if (next.updatedAt < this.#job.updatedAt) return true;
		if (isLiveSpeechTerminal(this.#job.status) && !isLiveSpeechTerminal(next.status)) return true;
		return false;
	}

	#reportListenerError(error: unknown): void {
		if (!this.#onListenerError) return;
		try {
			this.#onListenerError(toError(error));
		} catch {
			// Diagnostics cannot affect job state.
		}
	}
}
