/**
 * Embed 认证控制器（TASK-019/029）。
 *
 * 匿名流程：读取/创建 visitorId（storage）-> Exchange -> 持有短期 Access
 * Token（仅内存，不落 localStorage；PD-18 同类原则）。
 *
 * signed_user 流程（TASK-029）：Launch Token 来自宿主经 postMessage 的
 * `init`（本控制器不保存 Launch Token），Exchange 后立即丢弃；外部用户身份
 * 完全由服务端 `LaunchTokenVerifier` 建立（AD-11）。
 *
 * Token 过期/无效时重新 Exchange。logout 清除内存态与访客身份。
 */
import { type EmbedApi, EmbedApiError } from "./api.ts";
import { createVisitorStorage, type StorageLike } from "./storage.ts";
import type { ExchangeResponse } from "./types.ts";

export interface EmbedAuthState {
	readonly accessToken: string;
	readonly expiresAt: string;
	readonly principalId: string;
	readonly appName: string;
	readonly features: { readonly uploads: boolean; readonly speech: boolean; readonly avatar: boolean };
}

export class EmbedAuthController {
	private token: string | null = null;
	private principalId: string | null = null;
	private readonly storage: ReturnType<typeof createVisitorStorage>;
	private readonly api: EmbedApi;

	constructor(api: EmbedApi, storage: StorageLike) {
		this.api = api;
		this.storage = createVisitorStorage(storage);
	}

	get hasToken(): boolean {
		return this.token !== null;
	}

	/** 匿名 Exchange；同 App 同访客身份稳定（服务端按 subjectHash 收敛）。 */
	async signIn(publicAppId: string): Promise<EmbedAuthState> {
		const visitorId = this.storage.getOrCreateVisitorId();
		const response: ExchangeResponse = await this.api.exchange({
			publicAppId,
			mode: "anonymous",
			anonymousVisitorId: visitorId,
		});
		return this.accept(response);
	}

	/**
	 * signed_user Exchange（TASK-029）：launchToken 只经 postMessage 进入，
	 * 本方法立即用其换取 Access Token，**不留存 Launch Token**（PD-18）。
	 */
	async signInWithLaunchToken(publicAppId: string, launchToken: string): Promise<EmbedAuthState> {
		const response: ExchangeResponse = await this.api.exchange({
			publicAppId,
			mode: "signed_user",
			launchToken,
		});
		return this.accept(response);
	}

	private accept(response: ExchangeResponse): EmbedAuthState {
		this.token = response.accessToken;
		this.principalId = response.principal.id;
		return {
			accessToken: response.accessToken,
			expiresAt: response.expiresAt,
			principalId: response.principal.id,
			appName: response.app.name,
			features: response.app.features,
		};
	}

	/** 取当前 token；无则抛 EmbedApiError（调用方应触发 signIn）。 */
	getToken(): string {
		if (this.token === null) throw new EmbedApiError("NOT_SIGNED_IN", "尚未完成身份交换", false);
		return this.token;
	}

	getPrincipalId(): string | null {
		return this.principalId;
	}

	/** 清除内存态与访客身份（宿主 logout 时调用）。 */
	async logout(): Promise<void> {
		this.token = null;
		this.principalId = null;
		this.storage.clearVisitorId();
	}
}
