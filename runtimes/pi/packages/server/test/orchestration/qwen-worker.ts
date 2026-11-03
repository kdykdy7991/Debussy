import { CodingAgentPiSessionBackend } from "../../src/coding-agent/backend.ts";
import { ConversationService } from "../../src/embed/conversations/service.ts";
import { createOrchestrationTurnExecutor } from "../../src/orchestration/conversation-executor.ts";
import { WorkCredentialBox } from "../../src/orchestration/credentials.ts";
import { startOrchestrationDispatcher } from "../../src/orchestration/dispatcher.ts";
import { orchestrationExecutionConfigResolver } from "../../src/orchestration/execution-configuration.ts";
import { OrchestrationService } from "../../src/orchestration/service.ts";
import { OrchestrationStore } from "../../src/orchestration/store.ts";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import { createPublishingRepositories } from "../../src/persistence/postgres/repositories/index.ts";
import type { ControlService } from "../../src/publishing/control/service.ts";
import { createMcpRuntimeToolFactory } from "../../src/publishing/mcp/runtime-tools.ts";
import { createConversationRuntimeManager } from "../../src/runtime/conversation-runtime-manager.ts";
import { createPiRuntimeAdapter } from "../../src/runtime/pi-runtime-adapter.ts";

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	if (url.includes("127.0.0.1:3000")) {
		process.send?.("model-request");
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		signal?.addEventListener("abort", () => process.send?.("model-request-aborted"), { once: true });
	}
	return originalFetch(input, init);
};
const client = new PostgresClient({ url: process.env.TEST_DB!, searchPath: process.env.TEST_SCHEMA! });
const store = new OrchestrationStore(client, process.env.TEST_TENANT!, new WorkCredentialBox(Buffer.alloc(32, 7)));
const repos = createPublishingRepositories(client);
const backend = await CodingAgentPiSessionBackend.create({
	cwd: process.env.TEST_CWD!,
	agentDir: process.env.TEST_AGENT_DIR!,
	sessionDir: process.env.TEST_SESSION_DIR!,
	disableLocalSkills: true,
});
const mcpFactory = createMcpRuntimeToolFactory({ repositories: repos });
const adapter = createPiRuntimeAdapter({
	createMcpTools: async (spec, scope) => {
		const tools = await mcpFactory(spec, scope);
		return Object.assign(
			tools.map((tool) => ({
				...tool,
				execute: async (...args: Parameters<typeof tool.execute>) => {
					args[2]?.addEventListener("abort", () => process.send?.("tool-signal-aborted"), { once: true });
					return tool.execute(...args);
				},
			})),
			{ hydrateResourceReferences: tools.hydrateResourceReferences },
		);
	},
	createSession: async (options) => {
		const runtime = await backend.createSession({
			id: options.id,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			streamOptions: options.streamOptions,
			ephemeral: true,
			customTools: options.customTools,
			allowedToolNames: options.allowedToolNames,
			resourceOverrides: { systemPrompt: options.systemPrompt },
		});
		const dispose = runtime.dispose.bind(runtime);
		const abort = runtime.abort.bind(runtime);
		runtime.abort = async () => {
			process.send?.("runtime-abort");
			await abort();
			process.send?.("runtime-abort-done");
		};
		runtime.dispose = async () => {
			await dispose();
			process.send?.("runtime-disposed");
		};
		return runtime;
	},
});
const manager = createConversationRuntimeManager({
	opener: async (spec, scope) => {
		const opened = await adapter.open(spec, scope);
		if (!opened.ok) throw new Error(opened.reason);
		return opened.runtime;
	},
});
const conversations = new ConversationService({
	repositories: repos,
	resolveExecutionConfiguration: orchestrationExecutionConfigResolver(store, repos),
	turnExecutor: createOrchestrationTurnExecutor(manager, store),
	resetRuntime: (id) => manager.reset(id),
});
const service = new OrchestrationService(store, {} as ControlService, repos, conversations);
const dispatcher = await startOrchestrationDispatcher(service, () => process.send?.("dispatcher-error"));
process.send?.("ready");
process.on("message", async (message) => {
	if (message !== "close") return;
	await dispatcher.close();
	await manager.close();
	await client.close();
	process.exit(0);
});
