/**
 * State unions for publishing/embed domain objects.
 *
 * TypeScript `enum` is banned in this codebase, so states are string literal
 * unions plus narrow runtime predicates. `STATUS_VALUES` keeps the allowed
 * sets explicit so tests can assert exhaustiveness and the schema CHECK
 * constraints in section 26 can be kept in sync.
 */

export type TenantStatus = "active" | "suspended" | "archived";

export type PublishedAppStatus = "draft" | "active" | "suspended" | "archived";

export type AccessMode = "anonymous" | "signed_user" | "mixed";

/**
 * `validating` is a transient in-memory state during version creation; only
 * `ready` / `rejected` / `retired` are ever persisted (section 26.2).
 */
export type PublishedAppVersionStatus = "validating" | "ready" | "rejected" | "retired";

export type PrincipalType =
	| "platform_user"
	| "external_user"
	| "anonymous_visitor"
	| "service"
	| "platform_admin_preview";

export type PrincipalStatus = "active" | "blocked" | "deleted";

export type ConversationStatus = "active" | "archived" | "deleted";

export type AttachmentStatus = "staged" | "ready" | "rejected" | "deleted";

export type EmbedLaunchKeyStatus = "active" | "retiring" | "revoked";

/** Runtime lifecycle states from the state diagram in section 10. */
export type RuntimeState = "dormant" | "opening" | "active" | "running" | "cancelling" | "closing" | "failed";

export const TENANT_STATUS_VALUES: readonly TenantStatus[] = ["active", "suspended", "archived"];

export const PUBLISHED_APP_STATUS_VALUES: readonly PublishedAppStatus[] = ["draft", "active", "suspended", "archived"];

export const ACCESS_MODE_VALUES: readonly AccessMode[] = ["anonymous", "signed_user", "mixed"];

export const PUBLISHED_APP_VERSION_STATUS_VALUES: readonly PublishedAppVersionStatus[] = [
	"validating",
	"ready",
	"rejected",
	"retired",
];

export const PRINCIPAL_TYPE_VALUES: readonly PrincipalType[] = [
	"platform_user",
	"external_user",
	"anonymous_visitor",
	"service",
	"platform_admin_preview",
];

export const PRINCIPAL_STATUS_VALUES: readonly PrincipalStatus[] = ["active", "blocked", "deleted"];

export const CONVERSATION_STATUS_VALUES: readonly ConversationStatus[] = ["active", "archived", "deleted"];

export const ATTACHMENT_STATUS_VALUES: readonly AttachmentStatus[] = ["staged", "ready", "rejected", "deleted"];

export const EMBED_LAUNCH_KEY_STATUS_VALUES: readonly EmbedLaunchKeyStatus[] = ["active", "retiring", "revoked"];

export const RUNTIME_STATE_VALUES: readonly RuntimeState[] = [
	"dormant",
	"opening",
	"active",
	"running",
	"cancelling",
	"closing",
	"failed",
];

export function isTenantStatus(value: string): value is TenantStatus {
	return (TENANT_STATUS_VALUES as readonly string[]).includes(value);
}
export function isPublishedAppStatus(value: string): value is PublishedAppStatus {
	return (PUBLISHED_APP_STATUS_VALUES as readonly string[]).includes(value);
}
export function isAccessMode(value: string): value is AccessMode {
	return (ACCESS_MODE_VALUES as readonly string[]).includes(value);
}
export function isPublishedAppVersionStatus(value: string): value is PublishedAppVersionStatus {
	return (PUBLISHED_APP_VERSION_STATUS_VALUES as readonly string[]).includes(value);
}
export function isPrincipalType(value: string): value is PrincipalType {
	return (PRINCIPAL_TYPE_VALUES as readonly string[]).includes(value);
}
export function isPrincipalStatus(value: string): value is PrincipalStatus {
	return (PRINCIPAL_STATUS_VALUES as readonly string[]).includes(value);
}
export function isConversationStatus(value: string): value is ConversationStatus {
	return (CONVERSATION_STATUS_VALUES as readonly string[]).includes(value);
}
export function isAttachmentStatus(value: string): value is AttachmentStatus {
	return (ATTACHMENT_STATUS_VALUES as readonly string[]).includes(value);
}
export function isEmbedLaunchKeyStatus(value: string): value is EmbedLaunchKeyStatus {
	return (EMBED_LAUNCH_KEY_STATUS_VALUES as readonly string[]).includes(value);
}
export function isRuntimeState(value: string): value is RuntimeState {
	return (RUNTIME_STATE_VALUES as readonly string[]).includes(value);
}
