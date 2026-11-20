import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { ConversationService, type ConversationServiceOptions } from "../embed/conversations/service.ts";
import type { ControlPlaneHandle } from "../publishing/control/compose.ts";
import { createMcpRuntimeToolFactory } from "../publishing/mcp/runtime-tools.ts";
import type { McpNetworkPolicy } from "../publishing/mcp/secure-client.ts";
import type { SkillMaterializer } from "../publishing/runtime/skill-materializer.ts";
import { createConversationRuntimeManager } from "../runtime/conversation-runtime-manager.ts";
import { createPiRuntimeAdapter, type RuntimeSessionFactory } from "../runtime/pi-runtime-adapter.ts";
import type { SandboxConfig } from "../runtime/sandbox.ts";
import type { HttpRequestHandler } from "../types.ts";
import { ApiKeyStore } from "./api-key.ts";
import { McpRunGuard } from "./api-key-boundary.ts";
import { createApiKeyHttp } from "./api-key-http.ts";
import { IdempotencyKeyring } from "./api-key-idempotency.ts";
import { ApiKeyRunService } from "./api-key-runs.ts";
import { OrchestrationError } from "./contracts.ts";
import { createOrchestrationTurnExecutor } from "./conversation-executor.ts";
import { WorkCredentialBox } from "./credentials.ts";
import { startOrchestrationDispatcher } from "./dispatcher.ts";
import { orchestrationExecutionConfigResolver } from "./execution-configuration.ts";
import { createOrchestrationHttp } from "./http.ts";
import { createOrchestrationExecutionSource } from "./execution-source.ts";
import { protectTool } from "./protected-tool.ts";
import { RouterRuntime } from "./router-runtime.ts";
import { createRouterAdmin } from "./router-admin.ts";
import { OrchestrationService } from "./service.ts";
import { OrchestrationStore } from "./store.ts";

/** Thin composition around the shared execution core, isolated from browser connection lifetimes. */
export async function composeOrchestration(options: {
	control: ControlPlaneHandle;
	masterKey: Uint8Array;
	networkPolicy?: McpNetworkPolicy;
	createSession: RuntimeSessionFactory;
	sandboxConfig?: SandboxConfig;
	skillMaterializer: SkillMaterializer;
	resolveModelMetadata: ConversationServiceOptions["resolveModelMetadata"];
	onError: () => void;
	/** Compatibility rollback: preserve carrier protections and stop all new-Key execution. */
	legacyOnly?: boolean;
}) {
	if (typeof SettingsManager.prototype.setRuntimeCompactionMode !== "function")
		throw new Error("AaaS requires a matching pi-coding-agent build; rebuild the workspace before starting");
	const { control } = options;
	const store = new OrchestrationStore(control.client, control.tenantId, new WorkCredentialBox(options.masterKey));
	const apiKeys = new ApiKeyStore(control.client, control.tenantId, options.masterKey);
	const idempotency = new IdempotencyKeyring({ masterKey: options.masterKey });
	const mcpGuard = new McpRunGuard();
	const tools = createMcpRuntimeToolFactory({
		repositories: control.repositories,
		secretBox: control.mcpSecretBox,
		networkPolicy: options.networkPolicy,
		// One credential source drives the whole protection: the sealed Run
		// credentials, the pre-call revalidation and the audit attribution.
		executionSource: createOrchestrationExecutionSource({
			store,
			guard: mcpGuard,
			recordAudit: async (record) => {
				await control.repositories.mcpServers.recordCallAudit(record);
			},
		}),
		protectTool,
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
		turnExecutor: createOrchestrationTurnExecutor(manager, store),
		resetRuntime: (id) => manager.reset(id),
		resolveModelMetadata: options.resolveModelMetadata,
	});
	const service = new OrchestrationService(
		store,
		control.controlService,
		control.repositories,
		conversations,
		mcpGuard,
	);
	let dispatcher: Awaited<ReturnType<typeof startOrchestrationDispatcher>>;
	try {
		dispatcher = await startOrchestrationDispatcher(service, options.onError, { legacyOnly: options.legacyOnly });
	} catch (error) {
		await manager.close();
		throw error;
	}
	const runService = new ApiKeyRunService({
		client: control.client,
		tenantId: control.tenantId,
		store,
		keys: apiKeys,
		idempotency,
		repos: control.repositories,
	});
	const orchestrationHttp = createOrchestrationHttp(service, (request) => control.isAuthorized(request));
	const router = new RouterRuntime({
		client: control.client,
		tenantId: control.tenantId,
		keys: apiKeys,
		idempotency,
		adapter,
		sandboxConfig: options.sandboxConfig,
		repos: control.repositories,
		masterKey: options.masterKey,
		onError: options.onError,
	});
	const apiKeyHttp = createApiKeyHttp({
		keys: apiKeys,
		runs: runService,
		isAdmin: (request) => control.isAuthorized(request),
		routerAdmin: createRouterAdmin({
			client: control.client, tenantId: control.tenantId, repos: control.repositories, router,
			sandboxConfig: options.sandboxConfig,
			listModels: async () => {
				const models = await control.controlService.listLlmModels();
				if (!models.ok) throw new OrchestrationError(503, "MODEL_CATALOG_UNAVAILABLE", "无法加载模型目录");
				return models.data.items;
			},
		}),
	});
	if (options.legacyOnly !== true) await router.start();
	const routerHttp = router.http();
	const handler: HttpRequestHandler = async (request, response) =>
		(options.legacyOnly !== true && (await routerHttp(request, response))) ||
		(options.legacyOnly !== true && (await apiKeyHttp(request, response))) ||
		(await orchestrationHttp(request, response));
	return {
		handler,
		apiKeys,
		idempotency,
		router,
		async close() {
			try {
				await router.close();
				await dispatcher.close();
			} finally {
				await manager.close();
			}
		},
	};
}
