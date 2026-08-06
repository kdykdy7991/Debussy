import type { SessionProgressEvent } from "@earendil-works/pi-protocol";

export interface SessionEventLogOptions {
	/** Maximum number of buffered events before the oldest is dropped. */
	maxEvents: number;
	/** How long an appended event is retained before it is dropped. */
	retentionMs: number;
	/** Injectable clock for deterministic retention tests. Defaults to Date.now. */
	now?: () => number;
}

interface LoggedEvent {
	sequence: number;
	event: SessionProgressEvent;
	appendedAt: number;
}

/**
 * Per-session replay buffer for `session_progress` events.
 *
 * Sequences are assigned once per event and shared by every connection on the
 * session, so a reconnecting client can request exactly the events it has not
 * seen. The buffer is bounded by both event count and wall-clock retention;
 * whichever limit is reached first evicts the oldest entry.
 *
 * The buffer outlives the runtime that produced its events: it is only released
 * when the server closes or a log sits idle beyond its retention window (see
 * `LiveSessionManager`). This is what lets `resume` replay missed events after
 * a disconnect even though the session runtime may already be disposed.
 */
export class SessionEventLog {
	private readonly maxEvents: number;
	private readonly retentionMs: number;
	private readonly now: () => number;
	private readonly entries: LoggedEvent[] = [];
	private next = 1;
	private lastActivityAt = 0;

	constructor(options: SessionEventLogOptions) {
		this.maxEvents = options.maxEvents;
		this.retentionMs = options.retentionMs;
		this.now = options.now ?? Date.now;
	}

	/** Sequence position a client is caught up to after seeing everything buffered so far. */
	get lastSequence(): number {
		return this.next - 1;
	}

	/** When the log was last appended to; used to expire whole logs. */
	get lastActivityAtMs(): number {
		return this.lastActivityAt;
	}

	/** Assign the next sequence, buffer the event, and evict per the retention policy. */
	append(event: Omit<SessionProgressEvent, "sequence">): SessionProgressEvent {
		const sequence = this.next++;
		this.lastActivityAt = this.now();
		const stored: SessionProgressEvent = { ...event, sequence };
		this.entries.push({ sequence, event: stored, appendedAt: this.lastActivityAt });
		this.evictExpired();
		return stored;
	}

	/**
	 * Replay buffered events after `afterSequence` in order through `send`.
	 * Returns how far the replay reached and whether the requested position is
	 * outside the retained window (in which case the caller must reset to an
	 * authoritative snapshot instead of relying on the replay).
	 */
	async replay(
		afterSequence: number,
		send: (event: SessionProgressEvent) => Promise<boolean>,
	): Promise<{ replayedThrough: number; resetRequired: boolean }> {
		if (afterSequence > this.lastSequence) {
			return { replayedThrough: this.lastSequence, resetRequired: true };
		}
		const first = this.entries[0]?.sequence ?? this.lastSequence + 1;
		if (afterSequence < first - 1) {
			return { replayedThrough: this.lastSequence, resetRequired: true };
		}
		let replayedThrough = afterSequence;
		for (const entry of this.entries) {
			if (entry.sequence <= afterSequence) continue;
			const sent = await send(entry.event);
			if (sent) replayedThrough = entry.sequence;
			if (!sent) break;
		}
		return { replayedThrough, resetRequired: false };
	}

	private evictExpired(): void {
		const cutoff = this.now() - this.retentionMs;
		while (
			this.entries.length > 0 &&
			(this.entries[0]!.appendedAt < cutoff || this.entries.length > this.maxEvents)
		) {
			this.entries.shift();
		}
	}
}
