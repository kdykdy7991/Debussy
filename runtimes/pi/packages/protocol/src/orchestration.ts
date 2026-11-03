import type { AgentModelParameters } from "./admin-workbench-agents.ts";
import type { LlmAvailableModel } from "./admin-workbench-llm.ts";

export type ConfigurationPermission = "config.view" | "config.edit" | "config.publish";
export type ExternalConfigurationField = "systemPrompt" | "modelId" | "parameters" | "mcpServerIds";
export interface ExternalAgentConfiguration {
	readonly systemPrompt: string;
	readonly modelId: string;
	readonly parameters: AgentModelParameters;
	readonly mcpServerIds: readonly string[];
}
export interface ConfigurationGrant {
	readonly id: string;
	readonly name: string;
	readonly revision: number;
	readonly enabled: boolean;
	readonly permissions: readonly ConfigurationPermission[];
	readonly editable_fields: readonly ExternalConfigurationField[];
	readonly allowed_origins: readonly string[];
}
export interface ExternalConfigurationView {
	readonly integration_id: string;
	readonly name: string;
	readonly published_version: string;
	readonly published: ExternalAgentConfiguration;
	readonly draft: {
		readonly revision: number;
		readonly base_version: string;
		readonly configuration: ExternalAgentConfiguration;
	};
	readonly editable_fields: readonly ExternalConfigurationField[];
	readonly permissions: { readonly view: boolean; readonly edit: boolean; readonly publish: boolean };
	readonly options: {
		readonly models: OrchestrationCatalog["models"];
		readonly mcpServers: readonly { id: string; name: string; toolNames: readonly string[] }[];
	};
}

export interface OrchestrationCatalog {
	readonly mcpServers?: readonly {
		readonly id: string;
		readonly name: string;
		readonly revision: number;
		readonly tools: OrchestrationCatalog["applications"][number]["tools"];
	}[];
	readonly skills?: readonly { readonly id: string; readonly name: string; readonly revision: number }[];
	readonly models: readonly Pick<LlmAvailableModel, "id" | "name" | "provider" | "parameterCapabilities">[];
	readonly applications: readonly {
		readonly publicAppId: string;
		readonly name: string;
		readonly modelId: string;
		readonly connected: boolean;
		readonly tools: readonly {
			readonly mcpServerId: string;
			readonly serverName: string;
			readonly name: string;
			readonly credentialParameters: readonly string[];
		}[];
	}[];
}

export interface ToolCredentialBinding {
	readonly mcpServerId: string;
	readonly toolName: string;
	readonly parameter: string;
	readonly credential: string;
}

export interface OrchestrationIntegration {
	readonly configurationId?: string | null;
	readonly configurationSource?: "orchestration" | "legacy_orchestration";
	readonly id: string;
	readonly name: string;
	readonly publicAppId: string;
	readonly enabled: boolean;
	readonly revision: number;
	readonly versionId: string;
	readonly allowedModels: readonly string[];
	readonly bindings: readonly ToolCredentialBinding[];
}

export interface AnalysisConfiguration {
	readonly versionId?: string;
	readonly draftRevision?: number;
	readonly mcpServers?: readonly {
		readonly mcpServerId: string;
		readonly revision: number;
		readonly toolNames: readonly string[];
	}[];
	readonly skills?: readonly { readonly skillId: string; readonly revision: number }[];
	readonly revision: number;
	readonly systemPrompt: string;
	readonly modelId: string;
	readonly parameters: AgentModelParameters;
	readonly allowedModels: readonly string[];
}

export interface AnalysisEventRequest {
	readonly eventId: string;
	readonly alarmId: string;
	readonly input: string;
	readonly workItemId?: string;
	readonly credentials: Readonly<Record<string, string>>;
	readonly credentialExpiresAt: string;
}

export type AnalysisWorkState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AnalysisAssignmentView {
	readonly id: string;
	readonly eventId: string;
	readonly state: AnalysisWorkState;
	readonly turnId: string;
	readonly report: string | null;
	readonly error: string | null;
	readonly createdAt: string;
}

export interface AnalysisWorkItem {
	readonly id: string;
	readonly origin: "orchestration" | "aaas";
	readonly integrationId: string;
	readonly alarmId: string;
	readonly state: AnalysisWorkState;
	readonly configurationRevision: number;
	readonly conversationId: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly assignments: readonly AnalysisAssignmentView[];
	readonly report: string | null;
	readonly reportEventId: string | null;
}

export interface AaasRun {
	readonly run_id: string;
	readonly integration_id: string;
	readonly external_ref: { readonly type?: string; readonly id: string } | null;
	readonly metadata: Record<string, unknown> | null;
	readonly agent_version: string;
	readonly configuration_revision: number;
	readonly status: "queued" | "running" | "completed" | "failed" | "cancelled";
	/** Final model output, preserved verbatim; null before success, including on failure. */
	readonly result: string | null;
	readonly error: { readonly code: string } | null;
	readonly created_at: string;
	readonly started_at: string | null;
	readonly completed_at: string | null;
}
