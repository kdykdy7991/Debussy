import type { AdminAuthController } from "../../publishing/auth-controller.ts";

export class OrchestrationApiError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** Uses existing console authentication; business integration tokens stay on the host backend. */
export class OrchestrationApi {
	private readonly auth: AdminAuthController;
	constructor(auth: AdminAuthController) {
		this.auth = auth;
	}
	async request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
		const token = this.auth.getToken();
		if (!token) throw new Error("管理员尚未认证");
		const response = await fetch(
			`${this.auth.getSnapshot().baseUrl.replace(/\/+$/, "")}/api/admin/v1/orchestration/${path}`,
			{
				method,
				signal,
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
		);
		const result = (await response.json().catch(() => ({}))) as {
			data?: T;
			error?: { message?: string; code?: string };
		};
		if (response.status === 401) this.auth.failConnection("管理员认证失效");
		if (!response.ok)
			throw new OrchestrationApiError(
				response.status,
				result.error?.code ?? "HTTP_ERROR",
				result.error?.message ?? `编排服务暂不可用（HTTP ${response.status}）`,
			);
		if (!("data" in result)) throw new Error("服务返回了无法识别的数据，请刷新重试");
		return result.data as T;
	}
}
