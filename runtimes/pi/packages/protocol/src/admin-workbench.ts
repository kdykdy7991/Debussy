/**
 * Administrator workbench contracts shared by Admin Web and the Control API.
 *
 * UI terminology is intentionally shorter than the persistence vocabulary:
 * an Agent is the administrator-facing projection of an AgentDefinition, and
 * an Agent revision is one immutable AgentDefinition revision. Persistence and
 * existing Control endpoints keep their current names; new UI contracts do not
 * introduce a second wire entity.
 */

/** Display-prefixed resource identifiers exposed by HTTP APIs. */
export type TenantPublicId = `ten_${string}`;
export type AgentPublicId = `agent_${string}`;
export type PublishedAppPublicId = `app_${string}`;
export type PublishedAppLocator = `pub_${string}`;
export type PublishedAppVersionPublicId = `pav_${string}`;
export type PrincipalPublicId = `prn_${string}`;
export type ConversationPublicId = `conv_${string}`;
export type ConversationEventPublicId = `evt_${string}`;
export type TurnPublicId = `turn_${string}`;
export type RequestPublicId = `req_${string}`;

/** Frozen administrator-facing navigation labels. */
export const ADMIN_WORKBENCH_TERMS = {
	conversation: "对话",
	agent: "Agent",
	app: "应用",
	userConversations: "用户会话",
	settings: "设置",
} as const;

/** Canonical Admin routes. Entity builders accept only display-prefixed IDs. */
export const ADMIN_WORKBENCH_ROUTES = {
	conversation: "/",
	agents: "/agents",
	agent: (agentId: AgentPublicId): string => `/agents/${agentId}`,
	apps: "/apps",
	app: (appId: PublishedAppPublicId): string => `/apps/${appId}`,
	userConversations: "/conversations",
	userConversation: (conversationId: ConversationPublicId): string => `/conversations/${conversationId}`,
	settings: "/settings",
} as const;

/**
 * Resolve an obsolete standalone Publishing route to its workbench route.
 * Unknown descendants return `null` instead of being redirected ambiguously.
 */
export function legacyPublishingRedirect(pathname: string): string | null {
	if (pathname === "/publishing" || pathname === "/publishing/") return ADMIN_WORKBENCH_ROUTES.apps;
	const match = pathname.match(/^\/publishing\/apps\/(app_[^/]+)\/?$/);
	return match === null ? null : ADMIN_WORKBENCH_ROUTES.app(match[1] as PublishedAppPublicId);
}

/** Agent list projection. `id` is the AgentDefinition display ID. */
export interface AgentSummary {
	readonly id: AgentPublicId;
	readonly name: string;
	readonly description: string | null;
	readonly currentRevision: number;
	readonly modelId: string | null;
	readonly hasDraft: boolean;
	readonly associatedAppCount: number;
	readonly updatedAt: string;
}

/** Immutable AgentDefinition revision projection used by the Agent workspace. */
export interface AgentRevisionSummary {
	readonly agentId: AgentPublicId;
	readonly revision: number;
	readonly sourceHash: string;
	readonly changeSummary: string | null;
	readonly createdBy: string;
	readonly createdAt: string;
	readonly associatedVersionIds: readonly PublishedAppVersionPublicId[];
}

/** Published-user Conversation row for the administrator list; no message body or raw subject is included. */
export interface ConversationAdminSummary {
	readonly id: ConversationPublicId;
	readonly appId: PublishedAppPublicId;
	readonly publicAppId: PublishedAppLocator;
	readonly appName: string;
	readonly agentId: AgentPublicId;
	readonly principalDisplayId: string;
	readonly principalType: "external_user" | "anonymous_visitor" | "platform_user" | "service";
	readonly publishedAppVersionId: PublishedAppVersionPublicId;
	readonly title: string;
	readonly status: string;
	readonly messageCount: number;
	readonly errorCount: number;
	readonly lastEventSequence: number;
	readonly createdAt: string;
	readonly lastActiveAt: string;
}

/** Versioned append-only event returned by administrator event-log endpoints. */
export interface SessionEventEnvelope {
	readonly eventId: ConversationEventPublicId;
	readonly sessionId: ConversationPublicId;
	readonly sequence: number;
	readonly eventType: string;
	readonly schemaVersion: number;
	readonly turnId: TurnPublicId | null;
	readonly payload: unknown;
	readonly createdAt: string;
}

export const KNOWN_PUBLISHED_APP_STATUSES = ["draft", "active", "suspended", "archived"] as const;
export type KnownPublishedAppStatus = (typeof KNOWN_PUBLISHED_APP_STATUSES)[number];

export const KNOWN_PUBLISHED_APP_VERSION_STATUSES = ["validating", "ready", "rejected", "retired"] as const;
export type KnownPublishedAppVersionStatus = (typeof KNOWN_PUBLISHED_APP_VERSION_STATUSES)[number];

export const KNOWN_CONVERSATION_STATUSES = ["active", "archived", "deleted"] as const;
export type KnownConversationStatus = (typeof KNOWN_CONVERSATION_STATUSES)[number];

/** A known status may expose its normal actions; an unknown future status is always read-only. */
export type StatusResolution<Known extends string> =
	| { readonly kind: "known"; readonly value: Known; readonly readOnly: false }
	| { readonly kind: "unknown"; readonly value: string; readonly readOnly: true };

function resolveStatus<Known extends string>(values: readonly Known[], value: string): StatusResolution<Known> {
	return (values as readonly string[]).includes(value)
		? { kind: "known", value: value as Known, readOnly: false }
		: { kind: "unknown", value, readOnly: true };
}

/** Resolve a PublishedApp status for UI rendering and dangerous-action gating. */
export function resolvePublishedAppStatus(value: string): StatusResolution<KnownPublishedAppStatus> {
	return resolveStatus(KNOWN_PUBLISHED_APP_STATUSES, value);
}

/** Resolve a PublishedAppVersion status for UI rendering and mutation gating. */
export function resolvePublishedAppVersionStatus(value: string): StatusResolution<KnownPublishedAppVersionStatus> {
	return resolveStatus(KNOWN_PUBLISHED_APP_VERSION_STATUSES, value);
}

/** Resolve a Conversation status for administrator UI rendering and mutation gating. */
export function resolveConversationStatus(value: string): StatusResolution<KnownConversationStatus> {
	return resolveStatus(KNOWN_CONVERSATION_STATUSES, value);
}
