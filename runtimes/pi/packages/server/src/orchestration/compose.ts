import { ConversationService, type ConversationServiceOptions } from "../embed/conversations/service.ts";
import type { ControlPlaneHandle } from "../publishing/control/compose.ts";
import { createMcpRuntimeToolFactory } from "../publishing/mcp/runtime-tools.ts";
import type { McpNetworkPolicy } from "../publishing/mcp/secure-client.ts";
import type { SkillMaterializer } from "../publishing/runtime/skill-materializer.ts";
import { createConversationRuntimeManager } from "../runtime/conversation-runtime-manager.ts";
import { createPiRuntimeAdapter, type RuntimeSessionFactory } from "../runtime/pi-runtime-adapter.ts";
import { createOrchestrationTurnExecutor } from "./conversation-executor.ts";
import { WorkCredentialBox } from "./credentials.ts";
import { startOrchestrationDispatcher } from "./dispatcher.ts";
import { orchestrationExecutionConfigResolver } from "./execution-configuration.ts";
import { createOrchestrationHttp } from "./http.ts";
import { protectTool } from "./protected-tool.ts";
import { OrchestrationService } from "./service.ts";
import { OrchestrationStore } from "./store.ts";

/** Thin composition around the shared execution core, isolated from browser connection lifetimes. */
export async function composeOrchestration(options: {
	control: ControlPlaneHandle;
	masterKey: Uint8Array;
	networkPolicy?: McpNetworkPolicy;
	createSession: RuntimeSessionFactory;
	skillMaterializer: SkillMaterializer;
	resolveModelMetadata: ConversationServiceOptions["resolveModelMetadata"];
	onError: () => void;
}) {
	const { control } = options;
	const store = new OrchestrationStore(control.client, control.tenantId, new WorkCredentialBox(options.masterKey));
	const tools = createMcpRuntimeToolFactory({
		repositories: control.repositories,
		secretBox: control.mcpSecretBox,
		networkPolicy: options.networkPolicy,
		protectTool: async (scope, serverId, tool, schema) => {
			const bindings = (await store.toolBindings(scope.conversationId)).filter(
				(b) => b.mcpServerId === serverId && b.toolName === tool.name,
			);
			return protectTool(
				tool,
				schema,
				bindings,
				async () => (await store.credentials(scope.conversationId, scope.turnId!)).values,
			);
		},
	});
	const adapter = createPiRuntimeAdapter({
		createSession: options.createSession,
		createMcpTools: tools,
		skillMaterializer: options.skillMaterializer,
	});
	const manager = createConversationRuntimeManager({
		opener: async (spec, scope) => {
			const result = await adapter.open(spec, scope);
			if (!result.ok) throw new Error(result.reason);
			return result.runtime;
		},
	});
	const conversations = new ConversationService({
		repositories: control.repositories,
		resolveExecutionConfiguration: orchestrationExecutionConfigResolver(store, control.repositories),
		turnExecutor: createOrchestrationTurnExecutor(manager),
		resetRuntime: (id) => manager.reset(id),
		resolveModelMetadata: options.resolveModelMetadata,
	});
	const service = new OrchestrationService(store, control.controlService, control.repositories, conversations);
	let dispatcher: Awaited<ReturnType<typeof startOrchestrationDispatcher>>;
	try {
		dispatcher = await startOrchestrationDispatcher(service, options.onError);
	} catch (error) {
		await manager.close();
		throw error;
	}
	return {
		handler: createOrchestrationHttp(service, (request) => control.isAuthorized(request)),
		async close() {
			try {
				await dispatcher.close();
			} finally {
				await manager.close();
			}
		},
	};
}
