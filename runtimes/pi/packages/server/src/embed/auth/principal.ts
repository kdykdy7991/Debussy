/**
 * 匿名 Principal 建立（spec 7.1 + 27.4，TASK-015）。
 *
 * 一个匿名访客在每个 PublishedApp 下拥有一个稳定 Principal：原始
 * `anonymousVisitorId`（浏览器生成、不可猜测）永不落库、永不写日志，而是与
 * tenant、app 以及服务端 HMAC pepper 一起折叠成 256-bit subject hash
 * （AD-09 / spec 5.2）。唯一约束 `(tenant, app, type, subject_hash)` 保证：
 *
 * - 两个不同访客绝不共享 Principal（禁止所有匿名用户共用一个 Principal）；
 * - 同一访客多次 Exchange 解析到同一个 Principal（upsert 的 ON CONFLICT
 *   路径保留既有 id）；
 * - 清理浏览器数据会得到新身份，这是匿名模式的产品语义（PD-01/PD-02）。
 *
 * Exchange 同时执行 App 状态、accessMode 与 Origin 校验（复用 TASK-014 的
 * `originAllowed`，HTTP/Exchange/Realtime 共用同一策略函数），随后签发仅
 * 授权一个 App 和一个 Principal 的短期 Access Token。
 */
import { createHmac } from "node:crypto";
import {
	appNotFound,
	appSuspended,
	type EmbedError,
	forbidden,
	originNotAllowed,
} from "../../publishing/domain/errors.ts";
import type { PublishedAppId, TenantId } from "../../publishing/domain/ids.ts";
import { newPrincipalId, type PublicAppId, toPublicId } from "../../publishing/domain/ids.ts";
import type { PublishedAppRecord, PublishingRepositories } from "../../publishing/repositories.ts";
import { parseRuntimeSpec } from "../../publishing/runtime-spec/schema.ts";
import type { AccessTokenService } from "./access-token.ts";
import { originAllowed } from "./origin.ts";

/** 匿名访客 ID 的合理长度边界（32..512 字符，覆盖 hex/base64url 随机值）。 */
export const ANONYMOUS_VISITOR_ID_MIN_CHARS = 32;
export const ANONYMOUS_VISITOR_ID_MAX_CHARS = 512;

/**
 * 匿名访客在一个 App 内的确定性 subject hash：
 * `HMAC-SHA256(pepper, "anonymous\n<tenant>\n<app>\n<visitor>")`。pepper 是
 * 服务端秘密，因此落库的 hash 在脱离 pepper 后无法离线爆破或伪造。
 */
export function anonymousSubjectHash(
	pepper: string,
	tenantId: TenantId,
	publishedAppId: PublishedAppId,
	visitorId: string,
): string {
	return createHmac("sha256", pepper)
		.update(`anonymous\n${tenantId}\n${publishedAppId}\n${visitorId}`, "utf8")
		.digest("hex");
}

export interface ExchangeServiceOptions {
	readonly repositories: PublishingRepositories;
	readonly accessTokens: AccessTokenService;
	/** 匿名 subject hash 的服务端 HMAC pepper；永不写日志。 */
	readonly subjectPepper: string;
}

export type ExchangeResult<T> =
	| { readonly ok: true; readonly data: T }
	| { readonly ok: false; readonly error: EmbedError };

export interface AnonymousExchangeInput {
	readonly publicAppId: PublicAppId;
	readonly anonymousVisitorId: string;
	/** 请求 `Origin` 头；按 App allowlist 校验（spec 13.1）。 */
	readonly origin: string | undefined;
}

export interface ExchangeAppView {
	readonly publicAppId: string;
	readonly name: string;
	readonly currentVersionId: string | null;
	readonly features: { readonly uploads: boolean; readonly speech: boolean; readonly avatar: boolean };
}

export interface AnonymousExchangeData {
	readonly accessToken: string;
	readonly expiresAt: string;
	readonly principal: { readonly id: string; readonly type: "anonymous_visitor" };
	readonly app: ExchangeAppView;
}

export class ExchangeService {
	private readonly repos: PublishingRepositories;
	private readonly accessTokens: AccessTokenService;
	private readonly subjectPepper: string;

	constructor(options: ExchangeServiceOptions) {
		this.repos = options.repositories;
		this.accessTokens = options.accessTokens;
		this.subjectPepper = options.subjectPepper;
	}

	/**
	 * 匿名 Exchange（spec 27.4）：按 publicAppId 定位 App（公开定位符，非
	 * 凭据），校验 active / accessMode / Origin，upsert Principal，签发
	 * Access Token。返回的 token 只授权一个 Tenant + 一个 App + 一个
	 * Principal。
	 */
	async exchangeAnonymous(input: AnonymousExchangeInput): Promise<ExchangeResult<AnonymousExchangeData>> {
		const app = await this.repos.publishedApps.getByPublicAppId(input.publicAppId);
		if (app === undefined) return { ok: false, error: appNotFound() };
		if (app.status !== "active") return { ok: false, error: appSuspended("App is not active") };
		if (app.accessMode !== "anonymous" && app.accessMode !== "mixed") {
			return { ok: false, error: forbidden("App does not allow anonymous access") };
		}
		if (!originAllowed(input.origin, app.allowedOrigins)) {
			return { ok: false, error: originNotAllowed() };
		}

		const subjectHash = anonymousSubjectHash(
			this.subjectPepper,
			app.tenantId,
			app.publishedAppId,
			input.anonymousVisitorId,
		);
		// 按 (tenant, app, type, subjectHash) 唯一三元组 upsert：老访客解析到
		// 既有 Principal（ON CONFLICT 保留既有 id），新访客获得新 id。
		const principal = await this.repos.principals.upsert({
			principalId: newPrincipalId(),
			tenantId: app.tenantId,
			publishedAppId: app.publishedAppId,
			principalType: "anonymous_visitor",
			subjectHash,
			status: "active",
			createdAt: new Date(),
			lastSeenAt: new Date(),
		});
		if (principal.status !== "active") {
			return { ok: false, error: forbidden("Principal is not active") };
		}

		const signed = await this.accessTokens.sign({
			tenantId: app.tenantId,
			publishedAppId: app.publishedAppId,
			principalId: principal.principalId,
			principalType: principal.principalType,
			scopes: [],
			publishedAppVersionId: app.currentVersionId,
		});
		return {
			ok: true,
			data: {
				accessToken: signed.token,
				expiresAt: signed.expiresAt.toISOString(),
				principal: {
					id: toPublicId("PrincipalId", principal.principalId),
					type: "anonymous_visitor",
				},
				app: {
					publicAppId: app.publicAppId,
					name: app.name,
					currentVersionId:
						app.currentVersionId === null ? null : toPublicId("PublishedAppVersionId", app.currentVersionId),
					features: await this.readFeatures(app),
				},
			},
		};
	}

	/** 从当前版本的 RuntimeSpec 读取功能开关（27.4）；缺失/不可解析时全部关闭。 */
	private async readFeatures(app: PublishedAppRecord): Promise<ExchangeAppView["features"]> {
		if (app.currentVersionId === null) return { uploads: false, speech: false, avatar: false };
		const version = await this.repos.publishedAppVersions.get(
			{ tenantId: app.tenantId, publishedAppId: app.publishedAppId },
			app.currentVersionId,
		);
		if (version === undefined) return { uploads: false, speech: false, avatar: false };
		const parsed = parseRuntimeSpec(version.runtimeSpec);
		if (!parsed.ok) return { uploads: false, speech: false, avatar: false };
		return {
			uploads: parsed.spec.capabilities.uploads.enabled,
			speech: parsed.spec.capabilities.speech.enabled,
			avatar: parsed.spec.capabilities.avatar.enabled,
		};
	}
}
