import { describe, expect, test } from "vitest";
import { nextConversationFollow } from "../../src/conversation/scroll-follow.ts";

describe("conversation scroll following", () => {
	test("keeps following when streaming content grows without reader movement", () => {
		expect(nextConversationFollow(true, 300, 300, 180)).toBe(true);
	});

	test("pauses when the reader drags the scrollbar upward", () => {
		expect(nextConversationFollow(true, 300, 270, 40, true)).toBe(false);
	});

	test("keeps following when Markdown reflow or scroll anchoring moves the viewport", () => {
		expect(nextConversationFollow(true, 300, 270, 140)).toBe(true);
	});

	test("does not resume from content growth while the reader is viewing history", () => {
		expect(nextConversationFollow(false, 270, 270, 200)).toBe(false);
		expect(nextConversationFollow(false, 270, 380, 80)).toBe(false);
	});

	test("resumes when the reader scrolls down within 96px of the bottom", () => {
		expect(nextConversationFollow(false, 270, 380, 80, false, true)).toBe(true);
		expect(nextConversationFollow(false, 270, 350, 120, false, true)).toBe(false);
	});
});
