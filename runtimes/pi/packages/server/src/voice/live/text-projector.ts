/**
 * Incremental Markdown → speakable-text projector.
 *
 * Consumes one assistant text delta at a time and returns the *append-only*
 * slice of plain text that may be sent to the TTS. State is held across
 * deltas so multi-character markers (code fences, links, HTML tags, list
 * markers, emphasis spans) that straddle a delta boundary are handled
 * correctly — no per-delta regex.
 *
 * Pure logic. The projector never logs or stores the raw delta; only the
 * returned projected text is what later passes through the segmenter.
 *
 * Rules (Phase 2 Spec §9):
 *
 * - Heading / list / blockquote / emphasis / table markers are dropped.
 * - Fenced code: contents are skipped; the fence line itself drops.
 * - Inline code: keep contents, strip backticks.
 * - Link: emit the label, drop the URL.
 * - Image: emit the non-empty alt text, drop the rest; if alt is empty, skip.
 * - HTML tag: stripped, never executed.
 * - Escaped Markdown punctuation loses its backslash, becomes plain text.
 * - Tables: process row by row; the `|` separators are not spoken.
 *
 * Append-only: each call returns the slice newly added to the projected log.
 * `flush()` settles any open structure using a conservative policy that
 * never leaks a half-written URL or code-block contents. `reset()` clears
 * state for the next turn.
 */

export interface IncrementalSpeakableTextProjector {
	project(delta: string): string;
	flush(): string;
	reset(): void;
}

type FencedState = { kind: "none" } | { kind: "open"; marker: string; contentEmitted: boolean };

interface LinkState {
	label: string;
	targetOpen: boolean;
}

/** A `[…` that has not yet seen its closing `]`. Emits text only on commit. */
interface PendingLinkLabel {
	/** Partial label text seen so far, not yet flushed. */
	accumulated: string;
	/** Whether an image `!` prefix was consumed. */
	isImage: boolean;
	/** True when `]` was seen in a prior delta and we are now waiting for `(`. */
	closed: boolean;
}

type PendingListMarker = "-" | "*" | "+" | null;
type PendingHrMarker = "-" | "*" | "_" | null;

/** A `<tag…>` that has not yet seen its matching closer. Content is held. */
interface PendingHtmlPair {
	tagName: string;
}

interface ProjectorOptions {
	skipFencedCode?: boolean;
	dropImagesWithoutAlt?: boolean;
}

const DEFAULT_OPTIONS: Required<ProjectorOptions> = {
	skipFencedCode: true,
	dropImagesWithoutAlt: true,
};

/** HTML tag names whose inner text should never be spoken. */
const SKIP_HTML_TAG_NAMES = new Set<string>(["script", "style", "noembed", "noframes", "plaintext"]);

export function createSpeakableTextProjector(options: ProjectorOptions = {}): IncrementalSpeakableTextProjector {
	const opts: Required<ProjectorOptions> = { ...DEFAULT_OPTIONS, ...options };

	let fence: FencedState = { kind: "none" };
	let inlineBackticks = 0;
	let link: LinkState | null = null;
	let pendingLink: PendingLinkLabel | null = null;
	/**
	 * Set when we see `<tagName …>` whose body / closing tag may arrive in a
	 * later delta. Names tracked are those whose inner text contains prose we
	 * want to skip entirely (script, style, noembed, noframes, plaintext).
	 */
	let pendingSkipHtmlTag: PendingHtmlPair | null = null;
	let pendingListMarker: PendingListMarker = null;
	let pendingHrMarker: PendingHrMarker = null;

	return {
		project(delta: string): string {
			if (!delta) return "";
			let out = "";
			const append = (text: string): void => {
				if (text) out += text;
			};

			let i = 0;
			const n = delta.length;
			while (i < n) {
				const ch = delta.charAt(i);
				const next = i + 1 < n ? delta.charAt(i + 1) : "";

				// ---- fenced code region ----
				if (fence.kind === "open") {
					const lineEnd = delta.indexOf("\n", i);
					const line = lineEnd === -1 ? delta.slice(i) : delta.slice(i, lineEnd);
					if (line.trimStart().startsWith(fence.marker)) {
						fence = { kind: "none" };
						i = lineEnd === -1 ? n : lineEnd + 1;
						continue;
					}
					if (opts.skipFencedCode) {
						i = lineEnd === -1 ? n : lineEnd + 1;
						continue;
					}
					append(`${line}\n`);
					fence.contentEmitted = true;
					i = lineEnd === -1 ? n : lineEnd + 1;
					continue;
				}

				// ---- pending skip-html region (script/style/…) ----
				if (pendingSkipHtmlTag) {
					const needle = `</${pendingSkipHtmlTag.tagName}>`;
					const end = delta.toLowerCase().indexOf(needle.toLowerCase(), i);
					if (end === -1) {
						i = n;
						continue;
					}
					pendingSkipHtmlTag = null;
					i = end + needle.length;
					continue;
				}

				// ---- pending link target (after a closed label `]( …`) ----
				if (link?.targetOpen) {
					if (ch === ")") {
						link = null;
						i += 1;
					} else if (ch === "\n") {
						link = null;
						i += 1;
					} else {
						i += 1;
					}
					continue;
				}

				// ---- pending link/image label without a closing `]` ----
				if (pendingLink) {
					if (pendingLink.closed) {
						// We previously saw `]` with no `(`. If we now see `(`, commit
						// as a link / image. Otherwise abort and emit `[label]`.
						if (ch === "(") {
							const label = pendingLink.accumulated;
							const isImage = pendingLink.isImage;
							pendingLink = null;
							if (!isImage) append(label);
							const targetStart = i + 1;
							const targetEnd = findClosingParen(delta, targetStart);
							if (targetEnd !== -1) {
								if (isImage) {
									const trimmedLabel = label.trim();
									if (trimmedLabel) append(trimmedLabel);
								}
								i = targetEnd + 1;
							} else if (!isImage) {
								i = targetStart;
								link = { label, targetOpen: true };
							} else {
								i = targetStart;
							}
							continue;
						}
						// Not a link — emit `[label]` then process `ch` as plain.
						const accumulated = pendingLink.accumulated;
						pendingLink = null;
						append("[");
						append(accumulated);
						append("]");
						continue;
					}
					// We are still inside the label — keep accumulating.
					if (ch === "]") {
						const afterClose = i + 1;
						if (afterClose < n && delta.charAt(afterClose) === "(") {
							const label = pendingLink.accumulated;
							const isImage = pendingLink.isImage;
							pendingLink = null;
							if (!isImage) append(label);
							const targetStart = afterClose + 1;
							const targetEnd = findClosingParen(delta, targetStart);
							if (targetEnd !== -1) {
								if (isImage) {
									const trimmedLabel = label.trim();
									if (trimmedLabel) append(trimmedLabel);
								}
								i = targetEnd + 1;
							} else if (!isImage) {
								i = targetStart;
								link = { label, targetOpen: true };
							} else {
								i = targetStart;
							}
							continue;
						}
						if (afterClose === n) {
							// Closing bracket at end of delta — wait for `(` in next delta.
							pendingLink.closed = true;
							i = n;
							continue;
						}
						// `]` without `(` later in the same delta — abort as literal.
						const accumulated = pendingLink.accumulated;
						pendingLink = null;
						append("[");
						append(accumulated);
						append("]");
						i += 1;
						continue;
					}
					if (ch === "\n") {
						pendingLink = null;
						i += 1;
						continue;
					}
					pendingLink.accumulated += ch;
					i += 1;
					continue;
				}

				// ---- inline code run ----
				if (inlineBackticks > 0) {
					if (ch === "`") {
						const runLength = countRun(delta, i, "`");
						if (runLength === inlineBackticks) {
							inlineBackticks = 0;
							i += runLength;
							continue;
						}
						i += 1;
						continue;
					}
					if (ch === "\n") {
						append(" ");
						i += 1;
						continue;
					}
					append(ch);
					i += 1;
					continue;
				}

				// ---- resolve pending bullet marker from the previous delta ----
				if (pendingListMarker !== null) {
					if (ch === " " || ch === "\t") {
						i += 1;
						continue;
					}
					if (ch === "\n") {
						// Empty list item: drop marker silently.
						pendingListMarker = null;
						i += 1;
						continue;
					}
					// Real list body: emit a leading newline, then continue parsing ch.
					append("\n");
					pendingListMarker = null;
				}

				if (pendingHrMarker !== null) {
					if (ch === " " || ch === "\t") {
						i += 1;
						continue;
					}
					if (ch === "\n") {
						pendingHrMarker = null;
						i += 1;
						continue;
					}
					// Text after the HR-like run: not an HR, emit dash and re-process.
					const mark = pendingHrMarker;
					pendingHrMarker = null;
					append(mark);
					continue;
				}

				// ---- fenced code opener ----
				if (ch === "`" && countRun(delta, i, "`") >= 3) {
					const runLength = countRun(delta, i, "`");
					fence = { kind: "open", marker: "`".repeat(runLength), contentEmitted: false };
					const lineEnd = delta.indexOf("\n", i);
					i = lineEnd === -1 ? n : lineEnd + 1;
					continue;
				}
				if (ch === "~" && countRun(delta, i, "~") >= 3) {
					const runLength = countRun(delta, i, "~");
					fence = { kind: "open", marker: "~".repeat(runLength), contentEmitted: false };
					const lineEnd = delta.indexOf("\n", i);
					i = lineEnd === -1 ? n : lineEnd + 1;
					continue;
				}

				// ---- inline code opener ----
				if (ch === "`") {
					const runLength = countRun(delta, i, "`");
					inlineBackticks = runLength;
					i += runLength;
					continue;
				}

				// ---- image: ![alt](url) ----
				if (ch === "!" && next === "[") {
					pendingLink = { accumulated: "", isImage: true, closed: false };
					i += 2;
					continue;
				}

				// ---- link: [label](url) ----
				if (ch === "[" && !isInsideWord(delta, i)) {
					pendingLink = { accumulated: "", isImage: false, closed: false };
					i += 1;
					continue;
				}

				// ---- heading marker (line start) ----
				if (ch === "#" && (i === 0 || delta.charAt(i - 1) === "\n")) {
					const runLength = countRun(delta, i, "#");
					if (runLength >= 1 && runLength <= 6) {
						let j = i + runLength;
						while (j < n && (delta.charAt(j) === " " || delta.charAt(j) === "\t")) j += 1;
						// Always emit a soft cadence break so an isolated heading marker
						// split across deltas still produces a leading `\n` before its body.
						append("\n");
						i = j;
						continue;
					}
				}

				// ---- horizontal rule (`---`, `***`, `___` at line start) ----
				if ((ch === "-" || ch === "*" || ch === "_") && (i === 0 || delta.charAt(i - 1) === "\n")) {
					const runLength = countRun(delta, i, ch);
					if (runLength >= 3) {
						let k = i + runLength;
						while (k < n && (delta.charAt(k) === " " || delta.charAt(k) === "\t")) k += 1;
						if (k === n) {
							pendingHrMarker = ch;
							i = n;
							continue;
						}
						if (delta.charAt(k) === "\n") {
							i = k + 1;
							continue;
						}
					}
				}

				// ---- unordered list marker (line start, runLength < 3) ----
				if ((i === 0 || delta.charAt(i - 1) === "\n") && (ch === "-" || ch === "*" || ch === "+")) {
					const runLength = countRun(delta, i, ch);
					// runLength >= 3 was already handled by the HR check above;
					// fall back to plain text for a run with mixed punctuation.
					if (runLength === 1) {
						if (i + 1 >= n) {
							pendingListMarker = ch;
							i = n;
							continue;
						}
						if (next === " " || next === "\t") {
							let k = i + 1;
							while (k < n && (delta.charAt(k) === " " || delta.charAt(k) === "\t")) k += 1;
							if (k === n) {
								pendingListMarker = ch;
								i = n;
								continue;
							}
							if (delta.charAt(k) !== "\n") {
								append("\n");
								i = k;
								continue;
							}
							i = k + 1;
							continue;
						}
						if (next === "\n") {
							// Empty list item.
							i += 2;
							continue;
						}
					}
				}

				// ---- ordered list marker (line start) ----
				if ((i === 0 || delta.charAt(i - 1) === "\n") && /\d/.test(ch)) {
					let k = i + 1;
					while (k < n && /\d/.test(delta.charAt(k))) k += 1;
					if (k < n && (delta.charAt(k) === "." || delta.charAt(k) === ")")) {
						let body = k + 1;
						while (body < n && (delta.charAt(body) === " " || delta.charAt(body) === "\t")) body += 1;
						if (body < n && delta.charAt(body) !== "\n") {
							append("\n");
							i = body;
							continue;
						}
					}
				}

				// ---- block-quote marker ----
				if (ch === ">" && (i === 0 || delta.charAt(i - 1) === "\n")) {
					if (next === " " || next === "\t") {
						i += 2;
						continue;
					}
					if (next === ">") {
						i += 1;
						continue;
					}
				}

				// ---- table separator row ----
				if (ch === "|" && (i === 0 || delta.charAt(i - 1) === "\n")) {
					const lineEnd = delta.indexOf("\n", i);
					const line = lineEnd === -1 ? delta.slice(i) : delta.slice(i, lineEnd);
					if (/^\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-")) {
						i = lineEnd === -1 ? n : lineEnd + 1;
						continue;
					}
				}

				// ---- table cell pipe ----
				if (ch === "|" && !isInsideWord(delta, i)) {
					i += 1;
					continue;
				}

				// ---- HTML constructs ----
				if (ch === "<") {
					// Comment
					if (delta.startsWith("<!--", i)) {
						const end = delta.indexOf("-->", i + 4);
						if (end !== -1) {
							i = end + 3;
							continue;
						}
						i = n;
						continue;
					}
					// CDATA
					if (delta.startsWith("<![CDATA[", i)) {
						const end = delta.indexOf("]]>", i + 9);
						if (end !== -1) {
							i = end + 3;
							continue;
						}
						i = n;
						continue;
					}
					// Closing tag `</tag>`
					const closeMatch = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.exec(delta.slice(i));
					if (closeMatch) {
						i += closeMatch[0].length;
						continue;
					}
					// Opening or void/self-closing tag
					const openMatch = /^<([A-Za-z][A-Za-z0-9-]*)\b([^>]*)\/?>/.exec(delta.slice(i));
					if (openMatch) {
						const tagName = openMatch[1].toLowerCase();
						const _attrs = openMatch[2] ?? "";
						const selfClosing = openMatch[0].endsWith("/>");
						i += openMatch[0].length;
						if (SKIP_HTML_TAG_NAMES.has(tagName) && !selfClosing) {
							pendingSkipHtmlTag = { tagName };
						}
						continue;
					}
				}

				// ---- emphasis run ----
				if (ch === "*" || ch === "_") {
					const runLength = countRun(delta, i, ch);
					i += runLength;
					continue;
				}
				if (ch === "~" && countRun(delta, i, "~") >= 2) {
					const runLength = countRun(delta, i, "~");
					i += runLength;
					continue;
				}

				// ---- backslash escape ----
				if (ch === "\\" && i + 1 < n) {
					i += 1;
					continue;
				}

				// ---- plain character ----
				append(ch);
				i += 1;
			}

			return out;
		},

		flush(): string {
			// Reset stateful openers silently; never leak URLs or code bodies.
			if (link?.targetOpen) link = null;
			inlineBackticks = 0;
			if (fence.kind === "open") fence = { kind: "none" };
			pendingLink = null;
			pendingSkipHtmlTag = null;
			pendingListMarker = null;
			pendingHrMarker = null;
			return "";
		},

		reset(): void {
			fence = { kind: "none" };
			inlineBackticks = 0;
			link = null;
			pendingLink = null;
			pendingSkipHtmlTag = null;
			pendingListMarker = null;
			pendingHrMarker = null;
		},
	};
}

// ---- internal helpers ----

function countRun(input: string, start: number, character: string): number {
	let len = 0;
	while (start + len < input.length && input.charAt(start + len) === character) len += 1;
	return len;
}

function _readLinkLabel(input: string, afterBracket: number): string | null {
	let depth = 0;
	let i = afterBracket;
	while (i < input.length) {
		const ch = input.charAt(i);
		if (ch === "[") {
			if (depth === 1) return null;
			depth += 1;
		} else if (ch === "]") {
			if (depth === 0) return input.slice(afterBracket, i);
			depth -= 1;
		}
		i += 1;
	}
	return null;
}

function findClosingParen(input: string, start: number): number {
	let depth = 0;
	for (let i = start; i < input.length; i += 1) {
		const ch = input.charAt(i);
		if (ch === "(") depth += 1;
		else if (ch === ")") {
			if (depth === 0) return i;
			depth -= 1;
		}
	}
	return -1;
}

function isInsideWord(input: string, index: number): boolean {
	if (index === 0) return false;
	return /[A-Za-z0-9_]/.test(input.charAt(index - 1));
}
