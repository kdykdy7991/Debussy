/**
 * Admin Workbench Agent 工作区 DTO（WB-003 / SPEC §5.2 / §15.1）。
 *
 * 与持久化实体 `AgentDefinition` 的关系（WB-000 §3.1）：
 *
 *     UI Agent         = AgentDefinition 的管理员投影
 *     UI AgentRevision = 不可变 AgentDefinition revision
 *
 * 协议命名沿用现有 `AgentDefinition` 词汇，避免与持久化层混用第二套
 * 名称；UI 层在组件内仍称呼为 Agent（业务术语）。`AgentDefinition` 仅
 * 用于 HTTP 路径与持久化 key。
 *
 * 约束：
 *
 * - `id`、`revision`、`appId`、`versionId` 全部为 `*PublicId` template
 *   literal 类型，传输层禁止裸 UUID
 * - 历史 revision 不可变；`configSnapshot` 是写入时冻结的副本
 * - `hasDraft` 表示当前 latest revision 是否有未保存草稿（WB-003 范围内
 *   草稿由 web 端内存持有；未来如需服务端持久化由后续任务补）
 * - 任何失败响应统一 404，不区分 not-found vs cross-tenant
 */
import type {
	AgentPublicId,
	PublishedAppLocator,
	PublishedAppPublicId,
	PublishedAppVersionPublicId,
} from "./admin-workbench.ts";
import type { AgentMcpRevisionReference } from "./admin-workbench-mcp.ts";

/**
 * Single agent detail: latest saved revision + metadata.
 *
 * `configSnapshot` is the **latest saved** configuration; the dirty draft
 * lives on the client until "save" is called. `changeSummary` is the most
 * recent revision's changelog; a new revision overwrites the agent's
 * "current" change summary.
 */
export interface AgentDefinitionDetail {
	readonly id: AgentPublicId;
	readonly name: string;
	readonly description: string | null;
	readonly currentRevision: number;
	readonly modelId: string | null;
	readonly systemPrompt: string;
	readonly parameters: AgentModelParameters;
	readonly toolIds: readonly string[];
	readonly knowledgeBaseIds: readonly string[];
	readonly capabilities: AgentCapabilities;
	readonly skills?: readonly AgentSkillRevisionReference[];
	readonly mcpServers?: readonly AgentMcpRevisionReference[];
	readonly hasDraft: boolean;
	readonly updatedAt: string;
	readonly updatedBy: string;
	readonly changeSummary: string | null;
	readonly associatedAppCount: number;
}

/** Capability toggles surfaced in the Agent detail tab (SPEC §5.2). */
export interface AgentCapabilities {
	/** Show conversation history/sidebar and allow users to create additional conversations. */
	readonly newConversations?: boolean;
	readonly liveSpeech: boolean;
	readonly avatar: boolean;
	readonly attachments: boolean;
	readonly citations: boolean;
	readonly realtime: boolean;
	readonly webSearch: boolean;
}

/**
 * A single immutable AgentDefinition revision.
 *
 * Wire format: `id` + integer `revision` uniquely identifies the row.
 * `configSnapshot` is the frozen configuration captured at the time the
 * revision was created; the diff between two revisions is computed on the
 * server by the agent-revision diff endpoint and surfaced here as
 * `diffFromPrevious` (null for revision 1).
 */
export interface AgentDefinitionRevision {
	readonly id: AgentPublicId;
	readonly revision: number;
	readonly sourceHash: string;
	readonly changeSummary: string | null;
	readonly createdBy: string;
	readonly createdAt: string;
	readonly configSnapshot: AgentConfigSnapshot;
	/** Frozen extension bindings for this immutable Agent revision. */
	readonly skills?: readonly AgentSkillRevisionReference[];
	readonly mcpServers?: readonly AgentMcpRevisionReference[];
	readonly diffFromPrevious: AgentConfigDiff | null;
	readonly associatedVersionIds: readonly PublishedAppVersionPublicId[];
}

/** Snapshot captured into a revision; mirrors the editable form fields. */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentModelParameters {
	readonly reasoning?: {
		readonly enabled?: boolean;
		readonly effort?: ReasoningEffort;
	};
}

export interface AgentConfigSnapshot {
	readonly modelId: string | null;
	readonly systemPrompt: string;
	readonly parameters: AgentModelParameters;
	readonly toolIds: readonly string[];
	readonly knowledgeBaseIds: readonly string[];
	readonly capabilities: AgentCapabilities;
}

/** Diff between two consecutive revisions. */
export interface AgentConfigDiff {
	readonly changedFields: readonly AgentConfigField[];
	readonly promptDelta: string | null;
	readonly parametersDelta: Readonly<Record<string, ConfigFieldDelta>>;
	readonly toolsAdded: readonly string[];
	readonly toolsRemoved: readonly string[];
	readonly knowledgeAdded: readonly string[];
	readonly knowledgeRemoved: readonly string[];
	readonly capabilitiesChanged: readonly AgentCapabilityField[];
}

export type AgentConfigField =
	| "modelId"
	| "systemPrompt"
	| "parameters"
	| "toolIds"
	| "knowledgeBaseIds"
	| "capabilities";

export type AgentCapabilityField = keyof AgentCapabilities;

export type ConfigFieldDelta =
	| { readonly kind: "added"; readonly value: unknown }
	| { readonly kind: "removed"; readonly value: unknown }
	| { readonly kind: "changed"; readonly from: unknown; readonly to: unknown };

export interface AgentDefinitionRevisionListResponse {
	readonly items: readonly AgentDefinitionRevision[];
	readonly nextCursor: string | null;
}

/** A PublishedApp that uses this Agent's revisions. */
export interface AgentDefinitionAssociatedApp {
	readonly appId: PublishedAppPublicId;
	readonly publicAppId: PublishedAppLocator;
	readonly name: string;
	readonly status: string;
	readonly currentVersionId: PublishedAppVersionPublicId | null;
	/**
	 * P2 publish-status surface: the Agent Revision currently published and
	 * live (`sourceAgentRevision` of the app's current version). Optional —
	 * absent when the app has no current version yet.
	 */
	readonly sourceAgentRevision?: number;
	/** Monotonic version number of the live published version. */
	readonly versionNumber?: number;
	/** When the live version was created/published (ISO). */
	readonly publishedAt?: string;
	/** Public embed/chat link for the published Agent. */
	readonly embedUrl?: string;
}

/**
 * P2 one-click publish (`POST /api/control/v1/agent-definitions/:id/publish`).
 * The server resolves the Agent's LATEST revision, reuses-or-creates the
 * single internal published_app, creates + activates a version, and returns
 * the live publish state. No client-supplied revision / application / version.
 */
export interface AgentPublishResponse {
	readonly agentId: PublishedAppPublicId;
	readonly agentRevision: number;
	readonly publishedApp: {
		readonly id: PublishedAppPublicId;
		readonly publicAppId: PublishedAppLocator;
		readonly name: string;
		readonly status: string;
	};
	readonly version: {
		readonly id: PublishedAppVersionPublicId;
		readonly versionNumber: number;
		readonly status: string;
		readonly sourceAgentRevision: number;
		readonly runtimeSpecHash: string | null;
		readonly validationErrors: readonly unknown[];
	};
	readonly previousVersionId: PublishedAppVersionPublicId | null;
	readonly embedUrl: string;
}

/**
 * Save the current draft as a new immutable revision.
 *
 * Request: the full config snapshot the client wants to persist. Server
 * verifies it differs from the latest revision, generates the next
 * `revision` number, and stores it under the same `(id, revision)` pair.
 * Idempotency-Key is required for POST writes (spec 8.3).
 */
export interface SaveAgentRevisionRequest {
	readonly name?: string;
	readonly description?: string;
	readonly modelId: string | null;
	readonly systemPrompt: string;
	readonly parameters: AgentModelParameters;
	readonly toolIds: readonly string[];
	readonly knowledgeBaseIds: readonly string[];
	readonly capabilities: AgentCapabilities;
	readonly skills?: readonly AgentSkillRevisionReference[];
	readonly mcpServers?: readonly AgentMcpRevisionReference[];
	readonly changeSummary: string;
}

export interface AgentSkillRevisionReference {
	readonly skillId: string;
	readonly revision: number;
}

export interface SaveAgentRevisionResponse {
	readonly id: AgentPublicId;
	readonly revision: number;
	readonly sourceHash: string;
	readonly createdAt: string;
}

/** Create an Agent and its immutable revision 1 in one operation. */
export interface CreateAgentDefinitionRequest {
	readonly name: string;
	readonly description?: string;
	readonly modelId: string | null;
	readonly systemPrompt: string;
	readonly parameters: AgentModelParameters;
	readonly toolIds: readonly string[];
	readonly knowledgeBaseIds: readonly string[];
	readonly capabilities: AgentCapabilities;
	readonly skills?: readonly AgentSkillRevisionReference[];
	readonly mcpServers?: readonly AgentMcpRevisionReference[];
}

export type CreateAgentDefinitionResponse = SaveAgentRevisionResponse;

/**
 * Response shape for `POST /api/control/v1/agent-definitions/import-current`
 * (MVP-03). Server returns the freshly imported (or already-existing latest)
 * AgentDefinition. Re-importing an unchanged source hash is a natural
 * idempotent operation; clients should still send an Idempotency-Key so the
 * server can dedupe network retries.
 */
export interface ImportCurrentAgentResponse {
	readonly agentDefinitionId: AgentPublicId;
	readonly revision: number;
	readonly sourceHash: string;
	readonly warnings: readonly { readonly code: string; readonly path: string; readonly message: string }[];
}
