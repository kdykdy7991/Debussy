/**
 * Domain IDs for the publishing/embed planes.
 *
 * Spec section 24.1 freezes IDs as "UUIDv7 or equivalent non-enumerable IDs;
 * public IDs add a type prefix (`pub_`, `pav_`, `conv_`, ...) which is a
 * presentation concern only". The database columns are `uuid` (section 26.2),
 * so the **stored/internal form of every resource ID is a bare UUIDv7**
 * (kept as a branded string for type safety). The display prefixes are added
 * and stripped by the HTTP/representation layer via `toPublicId` /
 * `fromPublicId`; they never enter the database.
 *
 * The one exception is `PublicAppId`: it is a public locator stored in the
 * `published_apps.public_app_id` text column (not a resource id), so it keeps
 * its `pub_` prefix end-to-end.
 */
import { randomBytes } from "node:crypto";

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

interface Brand<Name extends string> {
	readonly __brand: Name;
}

export type TenantId = string & Brand<"TenantId">;
export type AgentDefinitionId = string & Brand<"AgentDefinitionId">;
export type PublishedAppId = string & Brand<"PublishedAppId">;
export type PublicAppId = string & Brand<"PublicAppId">;
export type PublishedAppVersionId = string & Brand<"PublishedAppVersionId">;
export type PrincipalId = string & Brand<"PrincipalId">;
export type ConversationId = string & Brand<"ConversationId">;
export type AttachmentId = string & Brand<"AttachmentId">;
export type ConversationEventId = string & Brand<"ConversationEventId">;
export type ConversationSummaryId = string & Brand<"ConversationSummaryId">;
export type TurnId = string & Brand<"TurnId">;
export type RequestId = string & Brand<"RequestId">;
export type IdempotencyKey = string & Brand<"IdempotencyKey">;
export type AuditEventId = string & Brand<"AuditEventId">;
export type LaunchKeyId = string & Brand<"LaunchKeyId">;
export type SkillId = string & Brand<"SkillId">;
export type SkillArtifactId = string & Brand<"SkillArtifactId">;
export type McpServerId = string & Brand<"McpServerId">;
export type McpToolId = string & Brand<"McpToolId">;
export type McpSecretId = string & Brand<"McpSecretId">;
export type McpCallAuditId = string & Brand<"McpCallAuditId">;
/** Admin workbench Debug Conversation identity (Phase 1). */
export type DebugConversationId = string & Brand<"DebugConversationId">;
export type DebugConversationEventId = string & Brand<"DebugConversationEventId">;

/** Identifier kinds and their display prefixes (representation layer only). */
export type IdKind =
	| "TenantId"
	| "AgentDefinitionId"
	| "PublishedAppId"
	| "PublishedAppVersionId"
	| "PrincipalId"
	| "ConversationId"
	| "AttachmentId"
	| "ConversationEventId"
	| "ConversationSummaryId"
	| "TurnId"
	| "RequestId"
	| "IdempotencyKey"
	| "AuditEventId"
	| "LaunchKeyId"
	| "SkillId"
	| "SkillArtifactId"
	| "McpServerId"
	| "McpToolId"
	| "McpSecretId"
	| "McpCallAuditId"
	| "DebugConversationId"
	| "DebugConversationEventId";

const ID_PREFIXES: Readonly<Record<IdKind, string>> = {
	TenantId: "ten_",
	AgentDefinitionId: "agent_",
	PublishedAppId: "app_",
	PublishedAppVersionId: "pav_",
	PrincipalId: "prn_",
	ConversationId: "conv_",
	AttachmentId: "att_",
	ConversationEventId: "evt_",
	ConversationSummaryId: "csum_",
	TurnId: "turn_",
	RequestId: "req_",
	IdempotencyKey: "idem_",
	AuditEventId: "aud_",
	LaunchKeyId: "lkey_",
	SkillId: "skill_",
	SkillArtifactId: "skart_",
	McpServerId: "mcp_",
	McpToolId: "mcptool_",
	McpSecretId: "mcpsec_",
	McpCallAuditId: "mcpaud_",
	DebugConversationId: "dconv_",
	DebugConversationEventId: "devt_",
};

/** Generate a UUIDv7 string: 48-bit millisecond timestamp + random bits. */
export function uuidv7(): string {
	const bytes = randomBytes(16);
	const millis = BigInt(Date.now());
	bytes[0] = Number((millis >> 40n) & 0xffn);
	bytes[1] = Number((millis >> 32n) & 0xffn);
	bytes[2] = Number((millis >> 24n) & 0xffn);
	bytes[3] = Number((millis >> 16n) & 0xffn);
	bytes[4] = Number((millis >> 8n) & 0xffn);
	bytes[5] = Number(millis & 0xffn);
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Buffer.from(bytes).toString("hex");
	return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

/** Validate a bare UUIDv7 string, returning null for anything else. */
export function isUuid(value: string): boolean {
	return new RegExp(`^${UUID_PATTERN}$`).test(value);
}

/** Validate a bare UUID id for `kind`, returning the branded value or null. */
export function parseId<Kind extends IdKind>(_kind: Kind, value: string): (string & Brand<Kind>) | null {
	if (!isUuid(value)) return null;
	return value as string & Brand<Kind>;
}

/** Validate a bare UUID id for `kind`, throwing on invalid input. */
export function parseIdOrThrow<Kind extends IdKind>(kind: Kind, value: string, label: string): string & Brand<Kind> {
	const parsed = parseId(kind, value);
	if (parsed === null) {
		throw new Error(`Invalid ${label}: expected a ${kind} identifier (bare UUIDv7), got ${JSON.stringify(value)}`);
	}
	return parsed;
}

/** Representation-layer prefix for a resource kind. */
export function idPrefix(kind: IdKind): string {
	return ID_PREFIXES[kind];
}

/** Add the display prefix for API responses: `uuid` -> `conv_<uuid>`. */
export function toPublicId<Kind extends IdKind>(kind: Kind, id: string & Brand<Kind>): string {
	return `${ID_PREFIXES[kind]}${id}`;
}

/** Strip and validate a display-prefixed id from API input, returning the bare id. */
export function fromPublicId<Kind extends IdKind>(kind: Kind, publicId: string): (string & Brand<Kind>) | null {
	const prefix = ID_PREFIXES[kind];
	if (!publicId.startsWith(prefix)) return null;
	return parseId(kind, publicId.slice(prefix.length));
}

/** Generate a bare UUIDv7 id for `kind`. */
function buildId(_kind: IdKind): string {
	return uuidv7();
}

export function newTenantId(): TenantId {
	return buildId("TenantId") as TenantId;
}
export function newAgentDefinitionId(): AgentDefinitionId {
	return buildId("AgentDefinitionId") as AgentDefinitionId;
}
export function newPublishedAppId(): PublishedAppId {
	return buildId("PublishedAppId") as PublishedAppId;
}
export function newPublishedAppVersionId(): PublishedAppVersionId {
	return buildId("PublishedAppVersionId") as PublishedAppVersionId;
}
export function newPrincipalId(): PrincipalId {
	return buildId("PrincipalId") as PrincipalId;
}
export function newConversationId(): ConversationId {
	return buildId("ConversationId") as ConversationId;
}
export function newAttachmentId(): AttachmentId {
	return buildId("AttachmentId") as AttachmentId;
}
export function newConversationEventId(): ConversationEventId {
	return buildId("ConversationEventId") as ConversationEventId;
}
export function newConversationSummaryId(): ConversationSummaryId {
	return buildId("ConversationSummaryId") as ConversationSummaryId;
}
export function newTurnId(): TurnId {
	return buildId("TurnId") as TurnId;
}
export function newRequestId(): RequestId {
	return buildId("RequestId") as RequestId;
}
export function newIdempotencyKey(): IdempotencyKey {
	return buildId("IdempotencyKey") as IdempotencyKey;
}
export function newAuditEventId(): AuditEventId {
	return buildId("AuditEventId") as AuditEventId;
}
export function newLaunchKeyId(): LaunchKeyId {
	return buildId("LaunchKeyId") as LaunchKeyId;
}
export function newSkillId(): SkillId {
	return buildId("SkillId") as SkillId;
}
export function newSkillArtifactId(): SkillArtifactId {
	return buildId("SkillArtifactId") as SkillArtifactId;
}
export function newMcpServerId(): McpServerId {
	return buildId("McpServerId") as McpServerId;
}
export function newMcpToolId(): McpToolId {
	return buildId("McpToolId") as McpToolId;
}
export function newMcpSecretId(): McpSecretId {
	return buildId("McpSecretId") as McpSecretId;
}
export function newMcpCallAuditId(): McpCallAuditId {
	return buildId("McpCallAuditId") as McpCallAuditId;
}
export function newDebugConversationId(): DebugConversationId {
	return buildId("DebugConversationId") as DebugConversationId;
}
export function newDebugConversationEventId(): DebugConversationEventId {
	return buildId("DebugConversationEventId") as DebugConversationEventId;
}

/** Public locator: stored in the `public_app_id` text column, keeps `pub_`. */
export function newPublicAppId(): PublicAppId {
	return `pub_${uuidv7()}` as PublicAppId;
}

/** Validate a public app locator (`pub_<uuid>`). */
export function parsePublicAppId(value: string): PublicAppId | null {
	return value.startsWith("pub_") && isUuid(value.slice(4)) ? (value as PublicAppId) : null;
}
