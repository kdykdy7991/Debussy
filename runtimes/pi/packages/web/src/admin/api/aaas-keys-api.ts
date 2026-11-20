import type { AdminAuthController } from "../../publishing/auth-controller.ts";

export type AaasConfigurationMode = "platform" | "configuration" | "version";
export type RouterScope = "legacy" | "dual" | "router";
export interface AaasKey {
	keyId: string;
	name: string;
	status: "enabled" | "disabled" | "revoked";
	createdAt: string;
	updatedAt: string;
	/** Legacy fixed Version ID binding, preserved until explicitly converted. */
	orchestrationVersionId?: string | null;
	orchestrationConfigurationId?: string | null;
	configurationMode?: AaasConfigurationMode;
	effectiveVersionId?: string | null;
	effectiveConfigurationId?: string | null;
	effectiveConfigurationName?: string | null;
	effectiveToolCount?: number;
	effectiveUnavailable?: boolean;
	routerCapabilityScope?: RouterScope;
	directCapabilityRevision?: number;
}

export interface RouterCapabilities {
	model: { provider: string; model_id: string; parameters: Record<string, string | number | boolean | null> };
	mcp_servers: { server_id: string; revision: number; authentication: "none" | "bearer" | "api_key"; tool_allowlist: string[] }[];
	local_tools?: "bash"[];
	skills: { skill_id: string; revision: number; artifact_hash: string }[];
	execution_policy: { max_pending_operations: number; queue_timeout_ms: number; credential_max_ms: number };
}

export interface RouterKeySettings {
	scope: RouterScope;
	capabilityRevision: number;
	capabilities: RouterCapabilities | null;
	canRollback: boolean;
}

export class AaasKeysApiError extends Error {
	readonly code: string | undefined;
	constructor(message: string, code: string | undefined) {
		super(message);
		this.code = code;
	}
}
export interface AaasConfigurationChoice {
	configuration_id: string;
	name: string;
	orchestration_version_id: string | null;
	revision: number | null;
	model_id: string | null;
	mcp_count: number;
	tool_count: number;
}
export interface AaasBinding {
	mcpServerId: string;
	toolName: string;
	parameter: string;
	credentialId: string;
}
export interface AaasConfig {
	configuration_id: string;
	orchestration_version_id: string;
	credential_bindings: AaasBinding[];
	enabled: boolean;
}
export interface AaasConfigVersion {
	configuration_id: string;
	orchestration_version_id: string;
	name: string;
	revision: number;
	model_id: string | null;
	created_at: string;
}
export class AaasKeysApi {
	private readonly auth: AdminAuthController;
	constructor(auth: AdminAuthController) {
		this.auth = auth;
	}
	async request<T>(path = "", method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
		const token = this.auth.getToken();
		if (!token) throw new Error("管理员尚未认证");
		const response = await fetch(
			`${this.auth.getSnapshot().baseUrl.replace(/\/+$/, "")}/api/admin/v1/aaas/keys${path}`,
			{
				method,
				...(signal ? { signal } : {}),
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
		);
		const result = (await response.json().catch(() => ({}))) as { data?: T; error?: { message?: string; code?: string } };
		if (response.status === 401 && !signal?.aborted) this.auth.failConnection("管理员认证失效");
		if (!response.ok) throw new AaasKeysApiError(result.error?.message ?? `请求失败（HTTP ${response.status}）`, result.error?.code);
		if (!("data" in result)) throw new Error("服务返回了无法识别的数据");
		return result.data as T;
	}
}

/** Create a Key and return the secret via the existing issuance dialog. */
export async function createAaasKey(
	api: AaasKeysApi,
	name: string,
	onIssued: (token: string) => void,
	versionId?: string | null,
	configurationId?: string | null,
	routerOnly = false,
): Promise<void> {
	const result = await api.request<AaasKey & { token: string }>("", "POST", {
		name,
		...(routerOnly ? { router_only: true } : {}),
		...(versionId ? { orchestration_version_id: versionId } : {}),
		...(configurationId ? { configuration_id: configurationId } : {}),
	});
	onIssued(result.token);
}
