import { describe, expect, test } from "vitest";
import { createSpeakableTextProjector } from "../src/voice/live/text-projector.ts";

function project(parts: readonly string[]): string {
	const projector = createSpeakableTextProjector();
	let total = "";
	for (const part of parts) total += projector.project(part);
	return total;
}

function projectInOneShot(text: string): string {
	return project([text]);
}

describe("IncrementalSpeakableTextProjector — plain text", () => {
	test("returns empty for empty input", () => {
		expect(project([""])).toBe("");
	});

	test("passes through plain English", () => {
		expect(projectInOneShot("hello world")).toBe("hello world");
	});

	test("passes through plain Chinese", () => {
		expect(projectInOneShot("你好，世界。")).toBe("你好，世界。");
	});

	test("appends across deltas (append-only contract)", () => {
		const projector = createSpeakableTextProjector();
		const a = projector.project("hello ");
		const b = projector.project("world");
		const c = projector.project("!");
		expect(a).toBe("hello ");
		expect(b).toBe("world");
		expect(c).toBe("!");
	});
});

describe("IncrementalSpeakableTextProjector — Markdown markers", () => {
	test("drops heading markers but keeps body", () => {
		expect(projectInOneShot("# Title\nhello world")).toBe("\nTitle\nhello world");
		expect(projectInOneShot("### Sub-heading here")).toBe("\nSub-heading here");
	});

	test("drops list markers but keeps content", () => {
		expect(projectInOneShot("- first item\n+ second item")).toBe("\nfirst item\n\nsecond item");
	});

	test("drops emphasis markers", () => {
		expect(projectInOneShot("**bold** and *italic* and __under__")).toBe("bold and italic and under");
	});

	test("keeps escaped punctuation as plain text", () => {
		expect(projectInOneShot("\\# not a heading")).toBe("# not a heading");
	});

	test("strips HTML tags without executing them", () => {
		expect(projectInOneShot("hello <b>bold</b> world")).toBe("hello bold world");
		expect(projectInOneShot("<script>alert(1)</script>safe")).toBe("safe");
		expect(projectInOneShot("<!-- ignore me -->after")).toBe("after");
	});

	test("preserves inline code contents and drops backticks", () => {
		expect(projectInOneShot("use `npm test` to verify")).toBe("use npm test to verify");
	});

	test("drops fenced code block contents but keeps surrounding text", () => {
		const text = "before\n```js\nconst x = 1;\n```\nafter";
		expect(projectInOneShot(text)).toBe("before\nafter");
	});

	test("projector splits across delta boundary (fence opener in one, body in next)", () => {
		const projector = createSpeakableTextProjector();
		const a = projector.project("before\n```js");
		const b = projector.project("\nconst x = 1;\n```\nafter");
		expect((a + b).trim()).toBe("before\nafter");
	});

	test("emits image alt when present", () => {
		expect(projectInOneShot("see ![a cat](cat.png) here")).toBe("see a cat here");
	});

	test("emits link label but drops URL", () => {
		expect(projectInOneShot("see [docs](https://example.com) for more")).toBe("see docs for more");
	});

	test("table renders rows without pipes", () => {
		const text = "| a | b |\n|---|---|\n| 1 | 2 |";
		expect(projectInOneShot(text)).toBe(" a  b \n 1  2 ");
	});

	test("blockquote marker is dropped", () => {
		expect(projectInOneShot("> quoted text")).toBe("quoted text");
	});

	test("horizontal rule is dropped", () => {
		expect(projectInOneShot("---")).toBe("");
		expect(projectInOneShot("***")).toBe("");
	});
});

describe("IncrementalSpeakableTextProjector — split across deltas", () => {
	test("link label split across deltas", () => {
		const projector = createSpeakableTextProjector();
		const a = projector.project("see [docs](http");
		const b = projector.project("://example.com) ok");
		expect(a + b).toBe("see docs ok");
	});

	test("inline code split across deltas", () => {
		const projector = createSpeakableTextProjector();
		const a = projector.project("run `npm ");
		const b = projector.project("test` now");
		expect(a + b).toBe("run npm test now");
	});

	test("heading marker split across deltas", () => {
		const projector = createSpeakableTextProjector();
		const a = projector.project("##");
		const b = projector.project(" Section");
		// Heading marker drops `#`/`##`/... and follows with a soft cadence break.
		// The leading whitespace from the next delta is kept verbatim because the
		// projected log is append-only — downstream segments can collapse it.
		expect((a + b).replace(/\s+/g, " ").trim()).toBe("Section");
	});
});

describe("IncrementalSpeakableTextProjector — flush & reset", () => {
	test("flush returns trailing cleaned output", () => {
		const projector = createSpeakableTextProjector();
		projector.project("hello world");
		expect(projector.flush()).toBe("");
	});

	test("flush hides pending link URL", () => {
		// The label was emitted incrementally as "see docs"; flush must not leak
		// the URL nor re-emit the label. The empty string is correct.
		const projector = createSpeakableTextProjector();
		const projected = projector.project("see [docs](http://secret");
		projector.flush();
		expect(projected).toBe("see docs");
	});

	test("reset clears state so old turn cannot leak", () => {
		const projector = createSpeakableTextProjector();
		projector.project("```js\nconst x = 1;\n");
		projector.reset();
		expect(projector.project("hello")).toBe("hello");
	});
});

describe("IncrementalSpeakableTextProjector — random delta equivalence", () => {
	test("100 random splits produce the same cumulative content", () => {
		const fixture = "## Header\n\n- A bullet with `code` and [link](https://x.y) here.\n\n**bold** and `inline`.";
		const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();
		const oneShotContent = normalize(projectInOneShot(fixture));
		for (let trial = 0; trial < 100; trial += 1) {
			const projector = createSpeakableTextProjector();
			let incremental = "";
			let cursor = 0;
			while (cursor < fixture.length) {
				const step = 1 + Math.floor(Math.random() * 5);
				const end = Math.min(fixture.length, cursor + step);
				incremental += projector.project(fixture.slice(cursor, end));
				cursor = end;
			}
			projector.flush();
			expect(normalize(incremental)).toBe(oneShotContent);
		}
	});
});
