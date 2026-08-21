import { describe, expect, test } from "vitest";
import { detectAgentReaction } from "../src/conversation/agent-reaction.ts";

describe("detectAgentReaction", () => {
	test.each([
		"很好，继续做上传功能",
		"做得漂亮",
		"真不错",
		"太棒了！",
		"Good job, keep going",
		"Looks good. Continue.",
	])("recognizes explicit praise: %s", (message) => expect(detectAgentReaction(message)).toBe("playful"));

	test.each(["不是很好，继续改", "不太好", "not good", "This isn't great", "继续做上传功能", "good morning"])(
		"does not react to negation or unrelated text: %s",
		(message) => expect(detectAgentReaction(message)).toBeUndefined(),
	);
});
