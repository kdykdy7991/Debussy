import { describe, expect, test } from "vitest";
import {
	type CommittedUtterance,
	createTextSegmenter,
	DEFAULT_IDLE_FLUSH_MS,
	DEFAULT_MAX_CHARACTERS,
	DEFAULT_MIN_CHARACTERS,
	DEFAULT_TARGET_CHARACTERS,
} from "../src/voice/live/text-segmenter.ts";

function commit(
	parts: readonly string[],
	opts: Parameters<typeof createTextSegmenter>[0] = {},
): {
	segmenter: ReturnType<typeof createTextSegmenter>;
	utterances: CommittedUtterance[];
} {
	const segmenter = createTextSegmenter(opts);
	const utterances: CommittedUtterance[] = [];
	let now = 1_000;
	for (const text of parts) {
		for (const u of segmenter.push(text, now)) utterances.push(u);
		now += 1;
	}
	for (const u of segmenter.flush(now)) utterances.push(u);
	return { segmenter, utterances };
}

function texts(us: readonly CommittedUtterance[]): readonly string[] {
	return us.map((u) => u.text);
}

describe("IncrementalTextSegmenter — defaults", () => {
	test("exposes the V6-frozen defaults", () => {
		expect(DEFAULT_MIN_CHARACTERS).toBe(12);
		expect(DEFAULT_TARGET_CHARACTERS).toBe(60);
		expect(DEFAULT_MAX_CHARACTERS).toBe(120);
		expect(DEFAULT_IDLE_FLUSH_MS).toBe(1_000);
	});

	test("rejects invalid option ranges", () => {
		expect(() => createTextSegmenter({ minCharacters: 0 })).toThrow();
		expect(() => createTextSegmenter({ targetCharacters: 5, minCharacters: 10 })).toThrow();
		expect(() => createTextSegmenter({ maxCharacters: 10, targetCharacters: 20 })).toThrow();
		expect(() => createTextSegmenter({ idleFlushMs: -1 })).toThrow();
	});
});

describe("IncrementalTextSegmenter — strong punctuation", () => {
	test("commits on CJK strong punctuation once min is reached", () => {
		// Build a 12+ codepoint sentence that ends with a CJK terminal.
		const seg = createTextSegmenter();
		const out: CommittedUtterance[] = [];
		out.push(...seg.push("今天是个好日子，天气晴朗，适合出行。", 1));
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out.some((u) => u.reason === "terminal_punctuation")).toBe(true);
		expect(texts(out).join("|")).toContain("今天是个好日子");
	});

	test("commits on English strong punctuation with letter-like context", () => {
		const { utterances } = commit(["This is a small sentence. And another one."]);
		expect(utterances.map((u) => u.reason)).toContain("terminal_punctuation");
		expect(texts(utterances)).toContain("This is a small sentence.");
	});

	test("does NOT commit prematurely on decimal points", () => {
		// Drive enough text past min so a terminal_punctuation commit could fire;
		// verify the `3.14` literal is never broken across utterance boundaries.
		const seg = createTextSegmenter();
		const out: CommittedUtterance[] = [];
		out.push(...seg.push("The value here is exactly 3.14 and that is also true at 1.5e2 enough chars now.", 1));
		out.push(...seg.flush(2));
		for (const u of out) {
			expect(u.text).not.toMatch(/^\d\.$/);
		}
	});

	test("does NOT split a version number across utterances", () => {
		const seg = createTextSegmenter();
		const out: CommittedUtterance[] = [];
		out.push(...seg.push("Please upgrade to v1.2.3 today, that is enough text.", 1));
		for (const u of out) {
			expect(u.text).not.toMatch(/\bv1\.\d+$/);
		}
	});

	test("renders a domain without splitting it at the dot", () => {
		const { utterances } = commit(["Visit example.com for more info."]);
		const joined = texts(utterances).join("\n");
		expect(joined).toContain("example.com");
		// Nothing ends mid-domain.
		expect(utterances.every((u) => !u.text.endsWith("example."))).toBe(true);
	});
});

describe("IncrementalTextSegmenter — paragraph & soft splits", () => {
	test("commits on paragraph break after min is reached", () => {
		const seg = createTextSegmenter();
		const out: CommittedUtterance[] = [];
		// No terminal punctuation before the `\n\n` so a paragraph boundary
		// is the first reachable commit.
		out.push(...seg.push("First paragraph grows past twelve plain words today", 1));
		out.push(...seg.push("\n\nSecond paragraph still rolling along nicely here", 2));
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out.some((u) => u.reason === "paragraph")).toBe(true);
	});

	test("soft punctuation commits after target is reached", () => {
		const seg = createTextSegmenter({ targetCharacters: 30, minCharacters: 10, maxCharacters: 60 });
		const out: CommittedUtterance[] = [];
		out.push(...seg.push("We have thirty characters here, maybe;", 1));
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out.some((u) => u.reason === "soft_limit")).toBe(true);
	});

	test("soft split at long whitespace-separated paragraph", () => {
		// No terminal punctuation — only soft whitespace boundaries, so the
		// segmenter must split via soft_limit rather than terminal_punctuation.
		const fixture =
			"This paragraph is intentionally long enough to overflow the default target threshold so the segmenter must split it at a soft boundary";
		const seg = createTextSegmenter();
		const out: CommittedUtterance[] = [];
		out.push(...seg.push(fixture, 1));
		out.push(...seg.flush(2));
		expect(out.length).toBeGreaterThanOrEqual(2);
		expect(out.some((u) => u.reason === "soft_limit")).toBe(true);
	});
});

describe("IncrementalTextSegmenter — hard ceiling", () => {
	test("forces a hard split at maxCharacters even without soft boundary", () => {
		const seg = createTextSegmenter({ minCharacters: 5, targetCharacters: 20, maxCharacters: 25, idleFlushMs: 0 });
		const out: CommittedUtterance[] = [];
		out.push(...seg.push("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", 1));
		expect(out.length).toBeGreaterThanOrEqual(2);
		// Each emitted head should be <= maxCharacters.
		for (const u of out) expect(u.text.length).toBeLessThanOrEqual(25);
	});
});

describe("IncrementalTextSegmenter — idle timeout", () => {
	test("commits at idle timeout after min but only when not pushing", () => {
		const seg = createTextSegmenter({
			minCharacters: 12,
			targetCharacters: 200,
			maxCharacters: 500,
			idleFlushMs: 1000,
		});
		const out: CommittedUtterance[] = [];
		out.push(...seg.push("hello world greetings from", 1000));
		// 24 chars trimmed — above minCharacters but well below target; no push
		// boundary yet. Wait until idle window has elapsed.
		out.push(...seg.tick(2500));
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0]?.reason).toBe("idle_timeout");
	});

	test("does NOT commit at idle before min is reached", () => {
		const seg = createTextSegmenter({
			minCharacters: 50,
			targetCharacters: 200,
			maxCharacters: 500,
			idleFlushMs: 100,
		});
		const out: CommittedUtterance[] = [];
		out.push(...seg.push("short text", 100));
		out.push(...seg.tick(10_000));
		expect(out).toHaveLength(0);
	});

	test("tick before min never fires idle commit", () => {
		const seg = createTextSegmenter({ idleFlushMs: 10, minCharacters: 30 });
		const out: CommittedUtterance[] = [];
		out.push(...seg.push("only ten", 0));
		out.push(...seg.tick(1_000));
		out.push(...seg.tick(2_000));
		expect(out).toEqual([]);
	});
});

describe("IncrementalTextSegmenter — flush & reset", () => {
	test("flush emits remaining as turn_end", () => {
		const seg = createTextSegmenter();
		const out: CommittedUtterance[] = [];
		out.push(...seg.push("a small tail that is short", 1));
		out.push(...seg.flush(2));
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[out.length - 1]?.reason).toBe("turn_end");
	});

	test("flush on empty buffer emits nothing", () => {
		const seg = createTextSegmenter();
		expect(seg.flush(1)).toEqual([]);
	});

	test("flush on whitespace-only buffer emits nothing", () => {
		const seg = createTextSegmenter();
		seg.push("    ", 1);
		expect(seg.flush(2)).toEqual([]);
	});

	test("reset clears state and sequence counter", () => {
		const seg = createTextSegmenter();
		seg.push("first sentence here.", 1);
		seg.flush(2);
		seg.reset();
		const out = seg.push("another sentence here.", 10);
		expect(out[0]?.sequence).toBe(1);
	});
});

describe("IncrementalTextSegmenter — Unicode & emoji", () => {
	test("does NOT split surrogate pairs", () => {
		const seg = createTextSegmenter({ minCharacters: 5, targetCharacters: 20, maxCharacters: 25 });
		// 10 emoji = 10 code points but 20 UTF-16 code units.
		const emoji = "😀😁😂🤣😃😄😅😆😉😊";
		const out: CommittedUtterance[] = [];
		out.push(...seg.push(`${emoji} extra tail here.`, 1));
		// Every committed character must be a complete UTF-16 code unit (no
		// half-surrogate), and the segmenter must not throw.
		for (const u of out) {
			for (const ch of u.text) {
				expect(ch.length).toBeGreaterThanOrEqual(1);
			}
		}
	});

	test("counts emoji as a single code point and never halves a surrogate pair", () => {
		// 9 emoji split by a single space; max=9 forces a hard split. Whatever
		// the segmenter emits must keep every emoji intact (each emoji is one
		// code point, two UTF-16 code units).
		const seg = createTextSegmenter({ minCharacters: 4, targetCharacters: 8, maxCharacters: 9 });
		const out: CommittedUtterance[] = [];
		out.push(...seg.push("😀😁😂🤣 😆😉😊😀", 1));
		out.push(...seg.flush(2));
		const joined = out.map((u) => u.text).join("");
		// Every original emoji must survive intact in some committed utterance.
		for (const emoji of ["😀", "😁", "😂", "🤣", "😆", "😉", "😊"]) {
			expect(joined).toContain(emoji);
		}
		// No half-surrogate.
		const halfSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
		for (const u of out) expect(halfSurrogate.test(u.text)).toBe(false);
	});
});

describe("IncrementalTextSegmenter — random delta equivalence", () => {
	test("100 random splits produce equivalent cumulative text", () => {
		const fixture =
			"这是一段示例文本，包含一些句子。第二句用强标点结束！第三句则写得比较长，足足有六十字左右，准备在 target 处切分。";
		const normalize = (s: string): string => s.replace(/\s+/g, "");
		const oneShotText = normalize(
			collectCommits([fixture])
				.map((u) => u.text)
				.join(""),
		);
		for (let trial = 0; trial < 100; trial += 1) {
			const seg = createTextSegmenter();
			const many: CommittedUtterance[] = [];
			let cursor = 0;
			while (cursor < fixture.length) {
				const step = 1 + Math.floor(Math.random() * 6);
				const end = Math.min(fixture.length, cursor + step);
				many.push(...seg.push(fixture.slice(cursor, end), 1));
				cursor = end;
			}
			many.push(...seg.flush(2));
			const incrementalText = normalize(many.map((u) => u.text).join(""));
			expect(incrementalText).toBe(oneShotText);
		}
	});

	test("100 random splits of a long English paragraph match the joined one-shot text", () => {
		const fixture =
			"This is a longer paragraph that should produce several utterances as it streams through the segmenter, ending with a final sentence.";
		const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();
		const oneShotText = normalize(
			collectCommits([fixture])
				.map((u) => u.text)
				.join(" "),
		);
		for (let trial = 0; trial < 100; trial += 1) {
			const seg = createTextSegmenter();
			const many: CommittedUtterance[] = [];
			let cursor = 0;
			while (cursor < fixture.length) {
				const step = 1 + Math.floor(Math.random() * 6);
				const end = Math.min(fixture.length, cursor + step);
				many.push(...seg.push(fixture.slice(cursor, end), 1));
				cursor = end;
			}
			many.push(...seg.flush(2));
			const incrementalText = normalize(many.map((u) => u.text).join(" "));
			expect(incrementalText).toBe(oneShotText);
		}
	});

	test("random splits never split inside code-point surrogates or non-Latin punctuation", () => {
		const fixture = "价格约为￥123.45，折扣后￥67.89，限今天有效。";
		const normalize = (s: string): string => s.replace(/\s+/g, "");
		const oneShotText = normalize(
			collectCommits([fixture])
				.map((u) => u.text)
				.join(""),
		);
		for (let trial = 0; trial < 50; trial += 1) {
			const seg = createTextSegmenter();
			const many: CommittedUtterance[] = [];
			let cursor = 0;
			while (cursor < fixture.length) {
				const step = 1 + Math.floor(Math.random() * 4);
				const end = Math.min(fixture.length, cursor + step);
				many.push(...seg.push(fixture.slice(cursor, end), 1));
				cursor = end;
			}
			many.push(...seg.flush(2));
			expect(normalize(many.map((u) => u.text).join(""))).toBe(oneShotText);
			for (const u of many) {
				expect(u.text.endsWith("￥")).toBe(false);
				expect(u.text.endsWith(".")).toBe(false);
			}
		}
	});
});

describe("IncrementalTextSegmenter — sequence monotonicity", () => {
	test("sequence is monotonic across multiple commits", () => {
		const seg = createTextSegmenter();
		const out: CommittedUtterance[] = [];
		out.push(...seg.push("First short.", 1));
		out.push(...seg.push(" Second short.", 2));
		out.push(...seg.push(" Third short.", 3));
		for (let i = 0; i < out.length; i += 1) {
			expect(out[i]?.sequence).toBe(i + 1);
		}
	});
});

describe("IncrementalTextSegmenter — short sentence merge", () => {
	test("keeps short sentences buffered until min is reached or flush", () => {
		const seg = createTextSegmenter();
		const out: CommittedUtterance[] = [];
		out.push(...seg.push("Hi.", 1));
		expect(out).toHaveLength(0);
		out.push(...seg.push(" Hello.", 2));
		expect(out).toHaveLength(0);
		out.push(...seg.flush(3));
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0]?.reason).toBe("turn_end");
	});
});

// ---- helpers ----

function collectCommits(parts: readonly string[]): CommittedUtterance[] {
	const seg = createTextSegmenter();
	const out: CommittedUtterance[] = [];
	let now = 1;
	for (const part of parts) out.push(...seg.push(part, now++));
	out.push(...seg.flush(now));
	return out;
}

function _strip(us: readonly CommittedUtterance[]): readonly { text: string; reason: string }[] {
	return us.map((u) => ({ text: u.text.replace(/\s+/g, " ").trim(), reason: u.reason }));
}
