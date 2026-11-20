import { ApiKeyStore } from "../../src/orchestration/api-key.ts";
import { IdempotencyKeyring } from "../../src/orchestration/api-key-idempotency.ts";
import { RouterRuntime } from "../../src/orchestration/router-runtime.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import { createPiRuntimeAdapter } from "../../src/runtime/pi-runtime-adapter.ts";
import type { LlmCallTrace, PiSessionRuntime, PromptInput } from "../../src/types.ts";

const url = process.env.ROUTER_TEST_DB_URL;
const tenantId = process.env.ROUTER_TEST_TENANT_ID;
if (!process.send || !url || !tenantId || !/^\/router_v1_phase4_/.test(new URL(url).pathname))
	throw new Error("This worker requires an isolated Router test database and an IPC parent");

const client = new PostgresClient({ url });
const masterKey = new Uint8Array(32).fill(41);
const runtime = new RouterRuntime({
	client,
	tenantId,
	keys: new ApiKeyStore(client, tenantId, masterKey),
	idempotency: new IdempotencyKeyring({ masterKey }),
	repos: createPublishingRepositories(client),
	masterKey,
	adapter: createPiRuntimeAdapter({
		createSession: async () =>
			({
				subscribe: () => () => {},
				prompt: async (input: PromptInput) => {
					const model = { provider: "test", id: "test-model" };
					await input.onLlmTrace?.({ kind: "request", callIndex: 1, model, context: { messages: [] } });
					await input.onLlmTrace?.({
						kind: "response",
						callIndex: 1,
						model,
						message: {
							role: "assistant",
							content: [],
							stopReason: "stop",
							timestamp: 1,
							usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6 },
						},
					} as unknown as LlmCallTrace);
					process.send?.("prompt");
					await new Promise(() => {});
				},
				abort: async () => {},
				dispose: async () => {},
			}) as unknown as PiSessionRuntime,
	}),
	onError: (error) => process.send?.({ error: error instanceof Error ? error.message : String(error) }),
});

process.on("message", async (message) => {
	if (message === "tick") {
		await runtime.tick();
		process.send?.("ticked");
	}
});
process.once("disconnect", () => process.exit(0));
process.send("ready");
