import { WorkCredentialBox } from "../../src/orchestration/credentials.ts";
import { startOrchestrationDispatcher } from "../../src/orchestration/dispatcher.ts";
import type { OrchestrationService } from "../../src/orchestration/service.ts";
import { OrchestrationStore } from "../../src/orchestration/store.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";

const client = new PostgresClient({ url: process.env.TEST_DB!, searchPath: process.env.TEST_SCHEMA! });
const store = new OrchestrationStore(client, process.env.TEST_TENANT!, new WorkCredentialBox(Buffer.alloc(32, 7)));
let stop: (() => void) | undefined;
const service = {
	store,
	execute: async () => {
		process.send?.("running");
		await new Promise<void>((resolve) => {
			stop = resolve;
		});
		process.send?.("stopped");
		return "late result";
	},
	abort: async () => {
		stop?.();
	},
} as unknown as OrchestrationService;
const dispatcher = await startOrchestrationDispatcher(service, () => process.send?.("error"));
process.send?.("ready");
process.on("message", async (message) => {
	if (message !== "close") return;
	await dispatcher.close();
	await client.close();
	process.exit(0);
});
