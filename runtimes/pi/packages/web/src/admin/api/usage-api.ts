import type { AdminUsageSummary } from "@earendil-works/pi-protocol";
import type { AdminAuthController } from "../../publishing/auth-controller.ts";

interface Envelope<T> {
	readonly data: T;
}

interface ErrorEnvelope {
	readonly error?: { readonly message?: string; readonly code?: string; readonly requestId?: string };
}

export class UsageApi {
	private readonly auth: AdminAuthController;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: { readonly auth: AdminAuthController; readonly fetchImpl?: typeof fetch }) {
		this.auth = options.auth;
		this.baseUrl = options.auth.getSnapshot().baseUrl.replace(/\/+$/, "");
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	}

	async getSummary(input: { readonly from: Date; readonly to: Date }): Promise<AdminUsageSummary> {
		const token = this.auth.getToken();
		if (!token) throw new Error("Admin token is not set");
		const query = new URLSearchParams({ from: input.from.toISOString(), to: input.to.toISOString() });
		const response = await this.fetchImpl(`${this.baseUrl}/api/control/v1/usage?${query.toString()}`, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
		});
		const body = (await response.json()) as Envelope<AdminUsageSummary> | ErrorEnvelope;
		if (!response.ok || !("data" in body)) {
			const error = "error" in body ? body.error : undefined;
			if (response.status === 401) this.auth.failConnection("Admin token rejected by server");
			throw new Error(error?.message ?? `HTTP ${response.status}`);
		}
		return body.data;
	}
}
