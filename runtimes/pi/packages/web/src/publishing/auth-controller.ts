/**
 * Publishing 控制台内存认证控制器（ADMIN-003）。
 *
 * 控制台不是 Embed；它只接受 `Authorization: Bearer <admin-token>`，并且
 * PD-18 同类原则：Token 永不进入 localStorage / sessionStorage / URL /
 * console / 异常文本。本类把 token 限制在 React Controller 内存里，刷新
 * 页面必须重新输入；401 自动锁定（清空 token 和所有管理数据）。
 *
 * 该类**没有**任何 Storage 字段；它只暴露内存 getter 和一个 `subscribe`
 * 钩子供 UI 组件订阅连接状态变化。
 */
import type { PublishingApiError, TenantInfo } from "./types.ts";

export type AdminConnectionState = "locked" | "connecting" | "connected" | "error";

export interface AdminAuthSnapshot {
	readonly state: AdminConnectionState;
	readonly baseUrl: string;
	readonly tenant: TenantInfo | null;
	readonly error: string | null;
}

export type AdminAuthListener = (snapshot: AdminAuthSnapshot) => void;

export interface AdminAuthControllerOptions {
	/** When false, the baseUrl field is editable; default true in production. */
	readonly lockBaseUrl?: boolean;
	readonly initialBaseUrl?: string;
}

export class AdminAuthController {
	private snapshot: AdminAuthSnapshot;
	private token: string | null = null;
	private readonly listeners = new Set<AdminAuthListener>();
	private readonly lockBaseUrl: boolean;

	constructor(options: AdminAuthControllerOptions = {}) {
		this.lockBaseUrl = options.lockBaseUrl ?? true;
		this.snapshot = {
			state: "locked",
			baseUrl: options.initialBaseUrl ?? defaultBaseUrl(),
			tenant: null,
			error: null,
		};
	}

	getSnapshot = (): AdminAuthSnapshot => this.snapshot;

	subscribe(listener: AdminAuthListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getToken(): string | null {
		return this.token;
	}

	hasToken(): boolean {
		return this.token !== null && this.token !== "";
	}

	/** Replace the in-memory token without notifying (used by connect). */
	connect(token: string): void {
		this.token = token;
		this.update({ state: "connecting", error: null });
	}

	async completeConnection(tenant: TenantInfo): Promise<void> {
		this.update({ state: "connected", tenant, error: null });
	}

	failConnection(error: string): void {
		// 401 (or any other failure) wipes the token + tenant data (ADMIN-003).
		this.token = null;
		this.update({ state: "error", error, tenant: null });
	}

	lock(): void {
		this.token = null;
		this.update({ state: "locked", error: null, tenant: null });
	}

	/**
	 * Change the base URL (settings). Any live connection MUST be dropped:
	 * the old token/tenant are bound to the previous origin, so the admin must
	 * re-unlock against the new base URL. This clears token + tenant data.
	 */
	setBaseUrl(baseUrl: string): void {
		this.token = null;
		this.update({ state: "locked", error: null, tenant: null, baseUrl: baseUrl.replace(/\/+$/, "") });
	}

	/**
	 * Reset every listener-visible field without retaining the token. Used by
	 * the controller layer when a 401 comes back from any mutation.
	 */
	handleApiError(error: PublishingApiError): boolean {
		if (error.httpStatus === 401) {
			this.token = null;
			this.update({ state: "error", error: error.message, tenant: null });
			return true;
		}
		return false;
	}

	private update(patch: Partial<AdminAuthSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		for (const listener of this.listeners) listener(this.snapshot);
	}
}

function defaultBaseUrl(): string {
	if (typeof window === "undefined") return "";
	const protocol = window.location.protocol === "https:" ? "https:" : "http:";
	return `${protocol}//${window.location.host}`;
}
