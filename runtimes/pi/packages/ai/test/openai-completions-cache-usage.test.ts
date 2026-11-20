import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

interface FakeUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number } | null;
	completion_tokens_details?: { reasoning_tokens?: number };
}

interface FakeChunk {
	id?: string;
	model?: string;
	choices?: unknown[];
	usage?: FakeUsage;
}

const mockState = {
	chunks: [] as FakeChunk[],
};

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of mockState.chunks) yield chunk;
						},
					};
					return Object.assign(Promise.resolve(stream), {
						withResponse: async () => ({
							data: stream,
							response: { status: 200, headers: new Headers() },
						}),
					});
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

function createModel(): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
	return {
		...(baseModel as Omit<Model<"openai-completions">, "api">),
		api: "openai-completions",
	};
}

function textChunk(content: string): FakeChunk {
	return { id: "chatcmpl-test", model: "gpt-4o-mini", choices: [{ delta: { content }, finish_reason: null }] };
}

function finishChunk(): FakeChunk {
	return { id: "chatcmpl-test", model: "gpt-4o-mini", choices: [{ delta: {}, finish_reason: "stop" }] };
}

function usageOnlyChunk(usage: FakeUsage): FakeChunk {
	return { id: "chatcmpl-test", model: "gpt-4o-mini", choices: [], usage };
}

async function runStream(...chunks: FakeChunk[]) {
	mockState.chunks = chunks;
	return streamOpenAICompletions(
		createModel(),
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{ apiKey: "test-key" },
	).result();
}

describe("openai-completions prompt cache usage reporting", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	it("reports a cache hit from prompt_tokens_details.cached_tokens", async () => {
		const message = await runStream(
			textChunk("ok"),
			finishChunk(),
			usageOnlyChunk({
				prompt_tokens: 2000,
				completion_tokens: 100,
				prompt_tokens_details: { cached_tokens: 1600 },
			}),
		);

		expect(message.usage.cacheRead).toBe(1600);
		expect(message.usage.cacheReadReported).toBe(true);
		expect(message.usage.input).toBe(400);
		expect(message.usage.output).toBe(100);
		expect(message.usage.totalTokens).toBe(2100);
	});

	it("reports an explicit zero cached_tokens as a verified cache miss", async () => {
		const message = await runStream(
			textChunk("ok"),
			finishChunk(),
			usageOnlyChunk({
				prompt_tokens: 2000,
				completion_tokens: 100,
				prompt_tokens_details: { cached_tokens: 0 },
			}),
		);

		expect(message.usage.cacheRead).toBe(0);
		expect(message.usage.cacheReadReported).toBe(true);
		expect(message.usage.input).toBe(2000);
		expect(message.usage.totalTokens).toBe(2100);
	});

	it("leaves cacheReadReported unset when prompt_tokens_details is missing", async () => {
		const message = await runStream(
			textChunk("ok"),
			finishChunk(),
			usageOnlyChunk({ prompt_tokens: 2000, completion_tokens: 100 }),
		);

		expect(message.usage.cacheRead).toBe(0);
		expect(message.usage.cacheReadReported).toBeUndefined();
		expect(Object.hasOwn(message.usage, "cacheReadReported")).toBe(false);
		expect(message.usage.input).toBe(2000);
	});

	it("treats a null cached_tokens as unreported rather than a cache miss", async () => {
		const message = await runStream(
			textChunk("ok"),
			finishChunk(),
			usageOnlyChunk({
				prompt_tokens: 2000,
				completion_tokens: 100,
				prompt_tokens_details: { cached_tokens: null },
			}),
		);

		expect(message.usage.cacheRead).toBe(0);
		expect(message.usage.cacheReadReported).toBeUndefined();
		expect(Object.hasOwn(message.usage, "cacheReadReported")).toBe(false);
	});

	it("reports the prompt_cache_hit_tokens fallback field as a cache hit", async () => {
		const message = await runStream(
			textChunk("ok"),
			finishChunk(),
			usageOnlyChunk({ prompt_tokens: 2000, completion_tokens: 100, prompt_cache_hit_tokens: 1600 }),
		);

		expect(message.usage.cacheRead).toBe(1600);
		expect(message.usage.cacheReadReported).toBe(true);
		expect(message.usage.input).toBe(400);
	});

	it("uses only the final usage chunk of a streamed completion", async () => {
		const message = await runStream(
			textChunk("ok"),
			usageOnlyChunk({
				prompt_tokens: 50,
				completion_tokens: 5,
				prompt_tokens_details: { cached_tokens: 10 },
			}),
			finishChunk(),
			usageOnlyChunk({
				prompt_tokens: 2000,
				completion_tokens: 100,
				prompt_tokens_details: { cached_tokens: 1600 },
			}),
		);

		expect(message.usage.cacheRead).toBe(1600);
		expect(message.usage.cacheReadReported).toBe(true);
		expect(message.usage.input).toBe(400);
		expect(message.usage.output).toBe(100);
		expect(message.usage.totalTokens).toBe(2100);
	});
});
