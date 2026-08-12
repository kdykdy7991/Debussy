/**
 * Incremental utterance segmenter.
 *
 * Receives the plain speakable text produced by the projector (one chunk per
 * push) and decides when to commit a CommittedUtterance for the TTS queue.
 *
 * Boundary priority (Phase 2 Spec §10):
 *
 * 1. Strong punctuation (`。！？` and reliable `.?!`) commits once the buffer
 *    has reached `minCharacters`.
 * 2. Paragraph break (`\n\n`) commits once `minCharacters` is reached.
 * 3. `maxCharacters` is a hard ceiling — the buffer MUST split there.
 * 4. `targetCharacters` reached → commit at the latest soft boundary
 *    (`；;：:，,` or whitespace) up to `targetCharacters`.
 * 5. `tick(now)` commits when `idleFlushMs` has passed since the last push,
 *    only after `minCharacters` has been reached.
 * 6. `flush()` commits whatever remains as a single `turn_end` utterance,
 *    unless the buffer is empty or only whitespace.
 *
 * The segmenter is pure with one injected dependency: the caller passes an
 * external `now` to `push` and `tick`. The segmenter never reads `Date.now()`
 * itself, so tests run deterministically.
 *
 * Committed utterances are immutable — `sequence` and `text` never change
 * after commit. Counts use Unicode code points, not UTF-16 code units, so
 * emoji and surrogate-pair characters are not split mid-character.
 */

export type CommitReason = "terminal_punctuation" | "paragraph" | "soft_limit" | "idle_timeout" | "turn_end";

export interface CommittedUtterance {
	/** Monotonically increasing from 1. Stable for the segmenter's lifetime. */
	sequence: number;
	/** Plain text to send to TTS. Immutable and already normalized. */
	text: string;
	/** Boundary that triggered the commit. */
	reason: CommitReason;
}

/** Public push-and-decide API. Mirrors Spec §10 verbatim. */
export interface IncrementalTextSegmenter {
	push(text: string, now: number): readonly CommittedUtterance[];
	tick(now: number): readonly CommittedUtterance[];
	flush(now: number): readonly CommittedUtterance[];
	reset(): void;
}

export interface IncrementalTextSegmenterOptions {
	minCharacters?: number;
	targetCharacters?: number;
	maxCharacters?: number;
	idleFlushMs?: number;
}

// Defaults frozen by V6; see PI-LIVE-AGENT-SPEECH-SPEC §10.
export const DEFAULT_MIN_CHARACTERS = 12;
export const DEFAULT_TARGET_CHARACTERS = 60;
export const DEFAULT_MAX_CHARACTERS = 120;
export const DEFAULT_IDLE_FLUSH_MS = 1000;

// CJK strong punctuation — unambiguous, always commits.
const STRONG_PUNCT_CJK = new Set<string>([
	"。", // 。
	"！", // ！
	"？", // ？
]);

// Soft boundaries — preferred commit points once target is reached or max is forced.
const SOFT_PUNCT = new Set<string>([
	"，", // ，
	"：", // ：
	"；", // ；
	",",
	":",
	";",
]);

const WHITESPACE = new Set<string>([" ", "\t", "\n", "\r", "　"]);

const DEFAULT_OPTIONS: Required<IncrementalTextSegmenterOptions> = {
	minCharacters: DEFAULT_MIN_CHARACTERS,
	targetCharacters: DEFAULT_TARGET_CHARACTERS,
	maxCharacters: DEFAULT_MAX_CHARACTERS,
	idleFlushMs: DEFAULT_IDLE_FLUSH_MS,
};

export function createTextSegmenter(options: IncrementalTextSegmenterOptions = {}): IncrementalTextSegmenter {
	const opts: Required<IncrementalTextSegmenterOptions> = { ...DEFAULT_OPTIONS, ...options };
	if (opts.minCharacters < 1) throw new RangeError("minCharacters must be >= 1");
	if (opts.targetCharacters < opts.minCharacters) {
		throw new RangeError("targetCharacters must be >= minCharacters");
	}
	if (opts.maxCharacters < opts.targetCharacters) {
		throw new RangeError("maxCharacters must be >= targetCharacters");
	}
	if (opts.idleFlushMs < 0) throw new RangeError("idleFlushMs must be >= 0");

	let buffer = "";
	let lastPushAt: number | null = null;
	let sequence = 0;

	function clearBuffer() {
		buffer = "";
		lastPushAt = null;
	}

	function codePointLength(text: string): number {
		let count = 0;
		for (const _ of text) count += 1;
		return count;
	}

	function trimmedBufferLength(): number {
		return codePointLength(buffer.replace(/\s+$/, ""));
	}

	function stripLeadingWhitespace(text: string): string {
		return text.replace(/^\s+/, "");
	}

	function append(text: string, now: number): readonly CommittedUtterance[] {
		if (!text) return [];
		buffer = stripLeadingWhitespace(buffer + text);
		lastPushAt = now;
		// Drain every boundary the buffer now exposes. Each call into emitUpTo
		// either produces one utterance and shrinks the buffer, or keeps the
		// buffer in place waiting for more text. The loop ends when no commit
		// fires.
		const emitted: CommittedUtterance[] = [];
		while (true) {
			const trimmedLen = trimmedBufferLength();
			if (trimmedLen < opts.minCharacters) break;
			const strongIdx = findStrongBoundary(buffer);
			if (strongIdx !== -1) {
				emitted.push(...emitUpTo(strongIdx, "terminal_punctuation"));
				continue;
			}
			const paraIdx = findParagraphBreak(buffer);
			if (paraIdx !== -1) {
				emitted.push(...emitUpTo(paraIdx, "paragraph"));
				continue;
			}
			const codeLen = codePointLength(buffer);
			if (codeLen >= opts.maxCharacters) {
				const split = findSplitAtMax(buffer, codeLen);
				const codePoints = Array.from(buffer);
				const trimmedHead = stripTrailingWhitespace(codePoints.slice(0, split).join(""));
				const reason = codePointLength(trimmedHead) >= opts.minCharacters ? "soft_limit" : "terminal_punctuation";
				emitted.push(...emitUpTo(split, reason));
				continue;
			}
			if (codeLen >= opts.targetCharacters) {
				const softIdx = findSoftBoundary(buffer);
				if (softIdx !== -1) {
					emitted.push(...emitUpTo(softIdx, "soft_limit"));
					continue;
				}
			}
			break;
		}
		return emitted;
	}

	function _commitStrongOrParagraph(): readonly CommittedUtterance[] {
		const trimmedLen = trimmedBufferLength();
		if (trimmedLen < opts.minCharacters) return [];
		const strongIdx = findStrongBoundary(buffer);
		if (strongIdx !== -1) return emitUpTo(strongIdx, "terminal_punctuation");
		const paraIdx = findParagraphBreak(buffer);
		if (paraIdx !== -1) {
			// Paragraph commit at the *start* of the `\n\n` (so the trailing
			// whitespace stays in the buffer to maintain cadence).
			return emitUpTo(paraIdx, "paragraph");
		}
		return [];
	}

	function tryHardOrSoftOrIdle(isIdle: boolean, now: number): readonly CommittedUtterance[] {
		const codeLen = codePointLength(buffer);
		if (codeLen === 0) return [];
		// Hard ceiling — must split, even if no soft boundary is available.
		if (codeLen >= opts.maxCharacters) {
			const split = findSplitAtMax(buffer, codeLen);
			const codePoints = Array.from(buffer);
			const trimmedHead = stripTrailingWhitespace(codePoints.slice(0, split).join(""));
			const reason = codePointLength(trimmedHead) >= opts.minCharacters ? "soft_limit" : "terminal_punctuation";
			return emitUpTo(split, reason);
		}
		if (codeLen >= opts.targetCharacters) {
			const softIdx = findSoftBoundary(buffer);
			if (softIdx !== -1) return emitUpTo(softIdx, "soft_limit");
		}
		if (
			isIdle &&
			lastPushAt !== null &&
			now - lastPushAt >= opts.idleFlushMs &&
			trimmedBufferLength() >= opts.minCharacters
		) {
			const softIdx = findSoftBoundary(buffer);
			const cutoff = softIdx !== -1 ? softIdx : codePointLength(buffer);
			return emitUpTo(cutoff, "idle_timeout");
		}
		return [];
	}

	function stripTrailingWhitespace(text: string): string {
		return text.replace(/\s+$/, "");
	}

	function emitUpTo(codepointCut: number, reason: CommitReason): readonly CommittedUtterance[] {
		if (codepointCut <= 0) return [];
		const codePoints = Array.from(buffer);
		if (codepointCut >= codePoints.length) {
			const trimmed = stripTrailingWhitespace(buffer);
			if (!trimmed) return [];
			clearBuffer();
			return [produceUtterance(trimmed, reason)];
		}
		const keptCode = stripLeadingWhitespace(codePoints.slice(codepointCut).join(""));
		const head = stripTrailingWhitespace(codePoints.slice(0, codepointCut).join(""));
		if (!head) {
			// Cut landed exactly on whitespace — hold off and keep waiting.
			buffer = keptCode;
			return [];
		}
		buffer = keptCode;
		return [produceUtterance(head, reason)];
	}

	function produceUtterance(text: string, reason: CommitReason): CommittedUtterance {
		sequence += 1;
		return { sequence, text, reason };
	}

	/**
	 * Locate the earliest code-point boundary that qualifies as "strong".
	 *
	 * CJK punctuation (`。！？`) commits unconditionally. ASCII `.?!` commit only
	 * when the next code point is whitespace or end-of-buffer, *and* the previous
	 * code point is letter-like (CJK ideograph, ASCII letter, or `_`). Digits,
	 * decimals (`3.14`), versions (`v1.2.3`), domains (`example.com`), and the
	 * trailing punctuation of an abbreviation are filtered out.
	 */
	function findStrongBoundary(input: string): number {
		const codePoints = Array.from(input);
		const letterLike = /[A-Za-z_一-鿿㐀-䶿]/;
		for (let i = 0; i < codePoints.length; i += 1) {
			const cp = codePoints[i];
			if (STRONG_PUNCT_CJK.has(cp)) return i + 1;
			if (cp === "." || cp === "!" || cp === "?") {
				const next = i + 1 < codePoints.length ? codePoints[i + 1] : "";
				const prev = i > 0 ? codePoints[i - 1] : "";
				const looksTerminator = (next === "" || WHITESPACE.has(next)) && prev !== "" && letterLike.test(prev);
				if (looksTerminator) return i + 1;
			}
		}
		return -1;
	}

	function findParagraphBreak(input: string): number {
		const codePoints = Array.from(input);
		for (let i = 0; i < codePoints.length - 1; i += 1) {
			if (codePoints[i] === "\n" && codePoints[i + 1] === "\n") return i;
		}
		return -1;
	}

	/**
	 * Find the latest soft boundary (`；;：:，,` or whitespace) at or before
	 * `targetCharacters`. Returns code-point index + 1 so the cut sits *after*
	 * the separator. Returns -1 if nothing fits inside the target window.
	 */
	function findSoftBoundary(input: string): number {
		const codePoints = Array.from(input);
		let best = -1;
		const upper = Math.min(opts.targetCharacters, codePoints.length);
		for (let i = 0; i < upper; i += 1) {
			const cp = codePoints[i];
			if (SOFT_PUNCT.has(cp) || cp === " ") best = i + 1;
		}
		return best;
	}

	function findSplitAtMax(input: string, codeLen: number): number {
		const codePoints = Array.from(input);
		const cap = Math.min(opts.maxCharacters, codeLen);
		let best = -1;
		for (let i = opts.targetCharacters; i < cap; i += 1) {
			const cp = codePoints[i];
			if (SOFT_PUNCT.has(cp) || cp === " ") best = i + 1;
		}
		return best !== -1 ? best : cap;
	}

	return {
		push(text: string, now: number): readonly CommittedUtterance[] {
			return append(text, now);
		},
		tick(now: number): readonly CommittedUtterance[] {
			// tick may run repeatedly; only emit when a boundary is reached.
			return tryHardOrSoftOrIdle(true, now);
		},
		flush(now: number): readonly CommittedUtterance[] {
			// `now` is accepted for symmetry with the spec; turn-end flush does
			// not depend on time. Empty / whitespace-only buffers commit nothing.
			void now;
			const trimmed = stripTrailingWhitespace(buffer);
			if (!trimmed) return [];
			clearBuffer();
			return [produceUtterance(trimmed, "turn_end")];
		},
		reset(): void {
			clearBuffer();
			sequence = 0;
		},
	};
}
