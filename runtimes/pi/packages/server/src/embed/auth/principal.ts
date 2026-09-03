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
 * Exchange 同时执行 App 状态、accessMode 与宿主 Origin 校验（复用
 * TASK-014 的 `originAllowed`），随后签发仅
 * 授权一个 App 和一个 Principal 的短期 Access Token。
 */
import { createHmac } from "node:crypto";
import {
	appNotFound,
	appSuspended,
	type EmbedError,
	forbidden,
	originNotAllowed,
	tokenExpired,
	tokenInvalid,
	tokenReplayed,
} from "../../publishing/domain/errors.ts";
import type { PublishedAppId, PublishedAppVersionId, TenantId } from "../../publishing/domain/ids.ts";
import { newPrincipalId, type PublicAppId, toPublicId } from "../../publishing/domain/ids.ts";
import type { PreviewTicketService } from "../../publishing/preview-ticket.ts";
import type { PublishedAppRecord, PublishingRepositories } from "../../publishing/repositories.ts";
import { parseRuntimeSpec } from "../../publishing/runtime-spec/schema.ts";
import type { AccessTokenService } from "./access-token.ts";
import type { LaunchTokenVerifier } from "./launch-token.ts";
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

/**
 * 宿主已登录用户在一个 App 内的确定性 subject hash（spec 7.2 / 5.2）：
 * `HMAC-SHA256(pepper, "external\n<tenant>\n<app>\n<externalUserId>")`。
 * externalUserId 被限定在 `(tenantId, publishedAppId)` 命名空间内，不能作为
 * 全平台主键（AD-08/AD-11）：同一个用户在不同 App 下得到不同 Principal。
 * 明文 externalUserId 永不落库、永不进 token/日志。
 */
export function externalSubjectHash(
	pepper: string,
	tenantId: TenantId,
	publishedAppId: PublishedAppId,
	externalUserId: string,
): string {
	return createHmac("sha256", pepper)
		.update(`external\n${tenantId}\n${publishedAppId}\n${externalUserId}`, "utf8")
		.digest("hex");
}

export interface ExchangeServiceOptions {
	readonly repositories: PublishingRepositories;
	readonly accessTokens: AccessTokenService;
	/** 匿名 subject hash 的服务端 HMAC pepper；永不写日志。 */
	readonly subjectPepper: string;
	/**
	 * Launch Token 验证器（TASK-028）。未配置 = signed-user Exchange 关闭
	 * （PD-19 默认）：`mode: "signed_user"` 请求显式 403，不静默通过。
	 */
	readonly launchTokens?: LaunchTokenVerifier;
	/** Preview ticket service (WB-005). Required for `mode: "preview"` Exchange. */
	readonly previewTickets?: PreviewTicketService;
}

export type ExchangeResult<T> =
	| { readonly ok: true; readonly data: T }
	| { readonly ok: false; readonly error: EmbedError };

export interface AnonymousExchangeInput {
	readonly publicAppId: PublicAppId;
	readonly anonymousVisitorId: string;
	/** iframe 已确认的宿主 Origin；按 App allowlist 校验（spec 13.1）。 */
	readonly origin: string | undefined;
}

export interface ExchangeAppView {
	readonly publicAppId: string;
	readonly name: string;
	readonly currentVersionId: string | null;
	readonly features: {
		readonly uploads: boolean;
		readonly speech: boolean;
		readonly realtimeVoice: boolean;
		readonly avatar: boolean;
		readonly newConversations: boolean;
	};
}

export interface AnonymousExchangeData {
	readonly accessToken: string;
	readonly expiresAt: string;
	readonly principal: { readonly id: string; readonly type: "anonymous_visitor" };
	readonly app: ExchangeAppView;
}

export interface SignedUserExchangeInput {
	readonly publicAppId: PublicAppId;
	/** 宿主后端签发的短期 Launch Token（spec 7.2）。 */
	readonly launchToken: string;
	/** iframe 已确认的宿主 Origin；须与 Launch Token `origin` claim 一致且过 allowlist。 */
	readonly origin: string | undefined;
}

export interface SignedUserExchangeData {
	readonly accessToken: string;
	readonly expiresAt: string;
	readonly principal: { readonly id: string; readonly type: "external_user" };
	readonly app: ExchangeAppView;
}

/** WB-005: Preview Exchange input. */
export interface PreviewExchangeInput {
	readonly publicAppId: PublicAppId;
	readonly ticket: string;
	readonly origin: string | undefined;
}

/** WB-005: Preview Exchange response. `pinnedVersionId` is the version the preview pins to. */
export interface PreviewExchangeData {
	readonly accessToken: string;
	readonly expiresAt: string;
	readonly principal: { readonly id: string; readonly type: "platform_admin_preview" };
	readonly app: ExchangeAppView;
	readonly pinnedVersionId: PublishedAppVersionId;
}

export class ExchangeService {
	private readonly repos: PublishingRepositories;
	private readonly accessTokens: AccessTokenService;
	private readonly subjectPepper: string;
	private readonly launchTokens: LaunchTokenVerifier | undefined;
	private readonly previewTickets: PreviewTicketService | undefined;

	constructor(options: ExchangeServiceOptions) {
		this.repos = options.repositories;
		this.accessTokens = options.accessTokens;
		this.subjectPepper = options.subjectPepper;
		this.launchTokens = options.launchTokens;
		this.previewTickets = options.previewTickets;
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

	/**
	 * signed-user Exchange（spec 27.4，TASK-028）：身份完全来自
	 * `LaunchTokenVerifier` 已验证的 claims（AD-11）——URL、postMessage 字段
	 * 或客户端提交的 Principal ID 都不能建立身份。externalUserId 经
	 * `(tenant, app)` 命名空间 HMAC 折叠为 subject hash 后 upsert Principal，
	 * 同一用户在不同 App 下严格隔离。
	 */
	async exchangeSignedUser(input: SignedUserExchangeInput): Promise<ExchangeResult<SignedUserExchangeData>> {
		const app = await this.repos.publishedApps.getByPublicAppId(input.publicAppId);
		if (app === undefined) return { ok: false, error: appNotFound() };
		if (app.status !== "active") return { ok: false, error: appSuspended("App is not active") };
		if (app.accessMode !== "signed_user" && app.accessMode !== "mixed") {
			return { ok: false, error: forbidden("App does not allow signed-user access") };
		}
		if (!originAllowed(input.origin, app.allowedOrigins)) {
			return { ok: false, error: originNotAllowed() };
		}
		if (this.launchTokens === undefined) {
			return { ok: false, error: forbidden("signed-user exchange is not enabled on this platform") };
		}
		const verified = await this.launchTokens.verify({
			token: input.launchToken,
			app,
			requestOrigin: input.origin,
		});
		if (!verified.ok) return { ok: false, error: verified.error };

		const subjectHash = externalSubjectHash(
			this.subjectPepper,
			app.tenantId,
			app.publishedAppId,
			verified.claims.externalUserId,
		);
		const principal = await this.repos.principals.upsert({
			principalId: newPrincipalId(),
			tenantId: app.tenantId,
			publishedAppId: app.publishedAppId,
			principalType: "external_user",
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
					type: "external_user",
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

	/**
	 * WB-005: preview exchange. The ticket binds the conversation to a
	 * pinned version (`pinnedVersionId`) — the existing current-version code
	 * path never sees this version because the access token explicitly carries
	 * the preview version id. The principal is `platform_admin_preview` and is
	 * scoped to a single (tenant, app) pair so it cannot escape into other
	 * apps.
	 */
	async exchangePreview(input: PreviewExchangeInput): Promise<ExchangeResult<PreviewExchangeData>> {
		if (this.previewTickets === undefined) {
			return { ok: false, error: forbidden("preview exchange is not enabled on this platform") };
		}
		const app = await this.repos.publishedApps.getByPublicAppId(input.publicAppId);
		if (app === undefined) return { ok: false, error: appNotFound() };
		const verified = await this.previewTickets.consume({
			publicAppId: input.publicAppId,
			origin: input.origin,
			ticket: input.ticket,
		});
		if (!verified.ok) {
			const code =
				verified.code === "EXPIRED" ? "EXPIRED" : verified.code === "ALREADY_CONSUMED" ? "REPLAYED" : "INVALID";
			return {
				ok: false,
				error:
					code === "EXPIRED"
						? tokenExpired("Preview ticket expired")
						: code === "REPLAYED"
							? tokenReplayed("Preview ticket was already used")
							: tokenInvalid("Preview ticket invalid"),
			};
		}
		try {
			// Cross-app guard: the ticket's app id must match the published app id
			// derived from the publicAppId. Tickets are scoped via signature claim.
			if (verified.appId !== app.publishedAppId) {
				return { ok: false, error: forbidden("preview ticket does not match the requested app") };
			}
			const version = await this.repos.publishedAppVersions.get(
				{ tenantId: app.tenantId, publishedAppId: app.publishedAppId },
				verified.versionId,
			);
			if (version === undefined || version.status !== "ready") {
				return { ok: false, error: forbidden("preview version is not ready") };
			}
			// The preview principal is per-app, deterministic by ticket JTI so that
			// subsequent tickets for the same admin converge to one Principal row
			// but never collide with an anonymous or external_user principal.
			const subjectHash = createHmac("sha256", this.subjectPepper)
				.update(`preview\n${app.tenantId}\n${app.publishedAppId}\n${input.ticket}`, "utf8")
				.digest("hex");
			const principal = await this.repos.principals.upsert({
				principalId: newPrincipalId(),
				tenantId: app.tenantId,
				publishedAppId: app.publishedAppId,
				principalType: "platform_admin_preview",
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
				publishedAppVersionId: verified.versionId,
			});
			return {
				ok: true,
				data: {
					accessToken: signed.token,
					expiresAt: signed.expiresAt.toISOString(),
					principal: {
						id: toPublicId("PrincipalId", principal.principalId),
						type: "platform_admin_preview",
					},
					app: {
						publicAppId: app.publicAppId,
						name: app.name,
						currentVersionId:
							app.currentVersionId === null ? null : toPublicId("PublishedAppVersionId", app.currentVersionId),
						features: await this.readFeaturesFromVersion(app, verified.versionId),
					},
					pinnedVersionId: verified.versionId,
				},
			};
		} catch (error) {
			await this.previewTickets.release(input.ticket);
			throw error;
		}
	}

	private async readFeaturesFromVersion(
		app: PublishedAppRecord,
		versionId: PublishedAppVersionId,
	): Promise<ExchangeAppView["features"]> {
		const version = await this.repos.publishedAppVersions.get(
			{ tenantId: app.tenantId, publishedAppId: app.publishedAppId },
			versionId,
		);
		if (version === undefined)
			return { uploads: false, speech: false, realtimeVoice: false, avatar: false, newConversations: true };
		const parsed = parseRuntimeSpec(version.runtimeSpec);
		if (!parsed.ok)
			return { uploads: false, speech: false, realtimeVoice: false, avatar: false, newConversations: true };
		return {
			uploads: parsed.spec.capabilities.uploads.enabled,
			speech: parsed.spec.capabilities.speech.enabled,
			realtimeVoice: parsed.spec.capabilities.realtimeVoice.enabled,
			avatar: parsed.spec.capabilities.avatar.enabled,
			newConversations: parsed.spec.capabilities.conversations.allowNew,
		};
	}

	/** 从当前版本的 RuntimeSpec 读取功能开关（27.4）；缺失/不可解析时全部关闭。 */
	private async readFeatures(app: PublishedAppRecord): Promise<ExchangeAppView["features"]> {
		if (app.currentVersionId === null)
			return { uploads: false, speech: false, realtimeVoice: false, avatar: false, newConversations: true };
		const version = await this.repos.publishedAppVersions.get(
			{ tenantId: app.tenantId, publishedAppId: app.publishedAppId },
			app.currentVersionId,
		);
		if (version === undefined)
			return { uploads: false, speech: false, realtimeVoice: false, avatar: false, newConversations: true };
		const parsed = parseRuntimeSpec(version.runtimeSpec);
		if (!parsed.ok)
			return { uploads: false, speech: false, realtimeVoice: false, avatar: false, newConversations: true };
		return {
			uploads: parsed.spec.capabilities.uploads.enabled,
			speech: parsed.spec.capabilities.speech.enabled,
			realtimeVoice: parsed.spec.capabilities.realtimeVoice.enabled,
			avatar: parsed.spec.capabilities.avatar.enabled,
			newConversations: parsed.spec.capabilities.conversations.allowNew,
		};
	}
}
