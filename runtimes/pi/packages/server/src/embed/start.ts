/**
 * Embed 数据面组合（spec 25.2，TASK-019 前置）。
 *
 * 把 Control/Data/Runtime 依赖组装成可挂载的 HTTP handler 集合：
 *
 * - `loadEmbedPlaneConfig`：校验 24.2 配置——pepper 与 Access Token 密钥
 *   文件缺失必须启动失败（不能静默退化为无鉴权模式），并加载 Ed25519 密钥。
 * - `createEmbedServices`：纯组装（可独立测试，不依赖 pi-coding-agent）——
 *   ExchangeService + ConversationService（注入 Runtime 适配）+ authenticator。
 * - `composeEmbedPlane`：组合入口，供 `startWebServer` 使用。
 *
 * 组合顺序（startWebServer）：先 composeControlPlane（含 PG 连接与 repos），
 * 再 composeEmbedPlane 复用同一 `repositories`；`createSession` 由调用方把
 * `CodingAgentPiSessionBackend.createSession` 适配为 `RuntimeSessionFactory`。
 */

import type { CitationService } from "../citations/service.ts";
import { S3ObjectStore } from "../persistence/object-store/s3.ts";
import type { ObjectStore } from "../persistence/object-store/types.ts";
import { RedisClient } from "../persistence/redis/client.ts";
import { createRedisNonceStore } from "../persistence/redis/nonce-store.ts";
import { createRedisTicketStore } from "../persistence/redis/ticket-store.ts";
import type { PublishingConfig } from "../publishing/config.ts";
import type { PublishingRepositories, UploadQuotaLimits } from "../publishing/repositories.ts";
import { createConversationRuntimeManager } from "../runtime/conversation-runtime-manager.ts";
import { createPiRuntimeAdapter, type RuntimeSessionFactory } from "../runtime/pi-runtime-adapter.ts";
import { managedTurnExecutor } from "../runtime/turn-executor.ts";
import type { HttpRequestHandler } from "../types.ts";
import { AccessTokenService, loadAccessTokenKeyMaterial } from "./auth/access-token.ts";
import { createExchangeHttpHandler } from "./auth/exchange-http.ts";
import { LaunchTokenVerifier } from "./auth/launch-token.ts";
import { ExchangeService } from "./auth/principal.ts";
import { createWsTicketService, type WsTicketService } from "./auth/ws-ticket.ts";
import { createBootstrapHttpHandler } from "./bootstrap-http.ts";
import { ConversationCitationService } from "./citations/service.ts";
import { createConversationsHttpHandler } from "./conversations/http.ts";
import { ConversationService } from "./conversations/service.ts";
import { createEmbedAuthenticator, type EmbedAuthContext } from "./middleware/authenticate.ts";
import { EmbedRealtimeConnection } from "./realtime/connection.ts";
import { createRealtimeUpgradeHandler, type UpgradeHandler } from "./realtime/http.ts";
import { conversationRealtimeServices } from "./realtime/services.ts";
import { createAttachmentsHttpHandler } from "./uploads/http.ts";
import { AttachmentService } from "./uploads/service.ts";

export interface EmbedPlaneOptions {
	readonly publishing: PublishingConfig;
	readonly repositories: PublishingRepositories;
	/** 底层会话工厂（真实组合接 CodingAgentPiSessionBackend.createSession）。 */
	readonly createSession: RuntimeSessionFactory;
	/** 附件对象存储（测试注入）；缺省按 `PI_OBJECT_STORE_*` 创建 S3。 */
	readonly objectStore?: ObjectStore;
	/** 附件 bucket（与 objectStore 成对；缺省用 config.objectStore.bucket）。 */
	readonly attachmentBucket?: string;
	/**
	 * 进程级 CitationService（TASK-032；与内部会话流共用同一实例）。未提供
	 * = embed 不上传引用/检索引用（upload 仍可用，Turn 不带 retrieval）。
	 */
	readonly citations?: CitationService;
	readonly log?: (message: string) => void;
}

export interface EmbedPlaneHandle {
	readonly bootstrapHandler: HttpRequestHandler;
	readonly exchangeHandler: HttpRequestHandler;
	readonly attachmentsHandler: HttpRequestHandler;
	readonly conversationsHandler: HttpRequestHandler;
	/** Realtime upgrade handler（挂到 listener 的 onUnhandledUpgrade）。 */
	readonly realtimeUpgrade: UpgradeHandler | undefined;
	readonly accessTokens: AccessTokenService;
	close(): Promise<void>;
}

export interface LoadedEmbedPlaneConfig {
	readonly accessTokens: AccessTokenService;
	/** 已校验非空的匿名 subject HMAC pepper。 */
	readonly subjectPepper: string;
}

/**
 * 校验并加载 Embed 数据面配置（spec 24.2）。任何缺失都是启动失败，
 * 绝不静默退化为无鉴权模式。
 */
export async function loadEmbedPlaneConfig(publishing: PublishingConfig): Promise<LoadedEmbedPlaneConfig> {
	const pepper = publishing.subjectPepper;
	if (pepper === undefined || pepper === "") {
		throw new Error("PI_EMBED_SUBJECT_PEPPER is required when publishing is enabled");
	}
	const privateKeyFile = publishing.accessTokenPrivateKeyFile;
	const publicKeyFile = publishing.accessTokenPublicKeyFile;
	const keyId = publishing.accessTokenKeyId;
	if (
		privateKeyFile === undefined ||
		privateKeyFile === "" ||
		publicKeyFile === undefined ||
		publicKeyFile === "" ||
		keyId === undefined ||
		keyId === ""
	) {
		throw new Error(
			"PI_EMBED_ACCESS_TOKEN_PRIVATE_KEY_FILE, PI_EMBED_ACCESS_TOKEN_PUBLIC_KEY_FILE and PI_EMBED_ACCESS_TOKEN_KEY_ID are required when publishing is enabled",
		);
	}
	const material = await loadAccessTokenKeyMaterial({ privateKeyFile, publicKeyFile });
	return {
		accessTokens: new AccessTokenService({
			issuer: publishing.embedBaseUrl,
			keyId,
			ttlSeconds: publishing.accessTokenTtlSeconds,
			...material,
		}),
		subjectPepper: pepper,
	};
}

export interface EmbedServicesOptions {
	readonly accessTokens: AccessTokenService;
	readonly subjectPepper: string;
	readonly repositories: PublishingRepositories;
	readonly createSession: RuntimeSessionFactory;
	/** WebSocket Ticket 服务（TASK-024/025）；未提供时 ws-ticket 端点 503。 */
	readonly wsTickets?: WsTicketService;
	/** Realtime 端点基地址（ws-ticket 响应 realtimeUrl）。 */
	readonly realtimeBaseUrl?: string;
	/** Realtime upgrade handler（TASK-025）；未提供时无 Realtime 端点。 */
	readonly realtimeUpgrade?: UpgradeHandler;
	/**
	 * Launch Token 验证器（TASK-028）。未提供 = signed-user Exchange 关闭
	 * （PD-19 默认）：signed_user 请求显式 403，不静默通过。
	 */
	readonly launchTokens?: LaunchTokenVerifier;
	/** 附件对象存储（TASK-030）；未提供时 uploads 端点显式 503。 */
	readonly objectStore?: ObjectStore;
	/** 对象存储 bucket（与 objectStore 一起提供）。 */
	readonly attachmentBucket?: string;
	/** 上传总量配额（TASK-031）；缺省用 service 平台默认。 */
	readonly uploadQuota?: UploadQuotaLimits;
	/** 进程级 CitationService（TASK-032）；未提供 = embed 引用链路关闭。 */
	readonly citations?: CitationService;
}

export interface EmbedServicesHandle {
	readonly handlers: readonly HttpRequestHandler[];
	readonly realtimeUpgrade: UpgradeHandler | undefined;
	/** 供 Realtime upgrade 闭包复用（授权后的 Turn/快照）。 */
	readonly conversationService: ConversationService;
	close(): Promise<void>;
}

/** 纯组装：Exchange + Conversations + authenticator + managed turn executor。 */
export function createEmbedServices(options: EmbedServicesOptions): EmbedServicesHandle {
	const adapter = createPiRuntimeAdapter({ createSession: options.createSession });
	const runtimeManager = createConversationRuntimeManager({
		opener: async (spec, scope) => {
			const opened = await adapter.open(spec, scope);
			if (!opened.ok) throw new Error(opened.reason);
			return opened.runtime;
		},
	});
	const exchangeService = new ExchangeService({
		repositories: options.repositories,
		accessTokens: options.accessTokens,
		subjectPepper: options.subjectPepper,
		launchTokens: options.launchTokens,
	});
	// TASK-032：会话级引用能力（进程级 CitationService + scope 适配器）。
	// 未提供 CitationService 时引用链路整体关闭（upload 仍可用）。
	const conversationCitations =
		options.citations !== undefined
			? new ConversationCitationService({
					citations: options.citations,
					repositories: options.repositories,
				})
			: undefined;
	const authenticator = createEmbedAuthenticator({ accessTokens: options.accessTokens });
	const conversationService = new ConversationService({
		repositories: options.repositories,
		turnExecutor: managedTurnExecutor(runtimeManager),
		...(conversationCitations !== undefined ? { citations: conversationCitations } : {}),
	});
	// TASK-030/031：附件对象存储 + 总量配额；未配置 store 时 uploads 端点
	// 503（不静默退化为磁盘）。
	const attachmentsService =
		options.objectStore !== undefined && options.attachmentBucket !== undefined
			? new AttachmentService({
					repositories: options.repositories,
					objectStore: options.objectStore,
					bucket: options.attachmentBucket,
					quota: options.uploadQuota,
					...(conversationCitations !== undefined ? { citations: conversationCitations } : {}),
				})
			: undefined;
	return {
		handlers: [
			createBootstrapHttpHandler({ repositories: options.repositories }),
			createExchangeHttpHandler({ service: exchangeService }),
			// uploads 必须先于 conversations 匹配（同路径前缀）。
			createAttachmentsHttpHandler({
				service: attachmentsService,
				authenticator,
				repositories: options.repositories,
			}),
			createConversationsHttpHandler({
				service: conversationService,
				authenticator,
				repositories: options.repositories,
				...(options.wsTickets !== undefined ? { wsTickets: options.wsTickets } : {}),
				...(options.realtimeBaseUrl !== undefined ? { realtimeBaseUrl: options.realtimeBaseUrl } : {}),
			}),
		],
		realtimeUpgrade: options.realtimeUpgrade,
		conversationService,
		close: () => runtimeManager.drain(),
	};
}

/** 组合 Embed 数据面。 */
export async function composeEmbedPlane(options: EmbedPlaneOptions): Promise<EmbedPlaneHandle> {
	const log = options.log ?? console.log.bind(console);
	const config = await loadEmbedPlaneConfig(options.publishing);

	// 24.2：启用 Embed 数据面需要 Redis（Ticket/限流/nonce）。
	const redisUrl = options.publishing.redisUrl;
	if (redisUrl === undefined || redisUrl === "") {
		throw new Error("PI_REDIS_URL is required when publishing is enabled");
	}
	const redis = new RedisClient({ url: redisUrl });
	const wsTickets = createWsTicketService(createRedisTicketStore(redis));
	// TASK-028：仅当配置了宿主 issuer 白名单时启用 signed-user Exchange
	// （PD-19 默认关闭；未启用时 signed_user 请求显式 403）。
	const launchTokens =
		options.publishing.launchTokenAllowedIssuers.length > 0
			? new LaunchTokenVerifier({
					repositories: options.repositories,
					nonces: createRedisNonceStore(redis),
					audience: options.publishing.launchTokenAudience,
					allowedIssuers: options.publishing.launchTokenAllowedIssuers,
				})
			: undefined;
	// TASK-030：附件对象存储——生产用 S3（24.2），测试可注入；未配置 =
	// uploads 显式 503，不静默退化为节点磁盘。
	const objectStore = options.objectStore ?? createObjectStoreFromConfig(options.publishing);
	const attachmentBucket = options.attachmentBucket ?? options.publishing.objectStore?.bucket;

	let realtimeUpgrade: UpgradeHandler | undefined;
	const services = createEmbedServices({
		accessTokens: config.accessTokens,
		subjectPepper: config.subjectPepper,
		repositories: options.repositories,
		createSession: options.createSession,
		wsTickets,
		realtimeBaseUrl: options.publishing.embedBaseUrl,
		launchTokens,
		...(objectStore !== undefined && attachmentBucket !== undefined ? { objectStore, attachmentBucket } : {}),
		uploadQuota: options.publishing.uploadQuota,
		...(options.citations !== undefined ? { citations: options.citations } : {}),
	});
	// Realtime 依赖 ConversationService（由 createEmbedServices 内部构造），
	// 因此 createSession 在此闭包内通过 services 暴露的连接工厂构建。
	realtimeUpgrade = services.realtimeUpgrade;
	log("embed data plane composed: bootstrap + exchange + conversations + dev turn + realtime");

	// 组装 Realtime upgrade：消费 Ticket -> 构建 EmbedRealtimeConnection。
	const conversationService = services.conversationService;
	realtimeUpgrade = createRealtimeUpgradeHandler({
		wsTickets,
		createSession: ({ ws, request, claims }) => {
			const principal: EmbedAuthContext = {
				tokenId: claims.tokenId,
				tenantId: claims.tenantId,
				publishedAppId: claims.publishedAppId,
				principalId: claims.principalId,
				principalType: claims.principalType,
				scopes: [],
				issuedAt: new Date(),
				expiresAt: new Date(),
			};
			new EmbedRealtimeConnection({
				ws,
				requestOrigin: request.headers.origin,
				claims,
				services: conversationRealtimeServices(conversationService),
				principal,
				onClose: (reason) => log(`realtime connection closed: ${reason}`),
			});
		},
		onError: (error) => log(`realtime upgrade error: ${error instanceof Error ? error.message : String(error)}`),
	});

	return {
		bootstrapHandler: services.handlers[0],
		exchangeHandler: services.handlers[1],
		attachmentsHandler: services.handlers[2],
		conversationsHandler: services.handlers[3],
		realtimeUpgrade,
		accessTokens: config.accessTokens,
		close: async () => {
			await services.close();
			await redis.close();
			await objectStore?.close();
		},
	};
}

/** 按 24.2 环境变量创建 S3 兼容对象存储；未配置返回 undefined（uploads 关闭）。 */
function createObjectStoreFromConfig(publishing: PublishingConfig): ObjectStore | undefined {
	const store = publishing.objectStore;
	if (store === undefined) return undefined;
	const url = new URL(store.endpoint);
	return new S3ObjectStore({
		endPoint: url.hostname,
		port: url.port === "" ? undefined : Number(url.port),
		useSSL: url.protocol === "https:",
		accessKey: store.accessKeyId,
		secretKey: store.secretAccessKey,
		region: store.region,
		bucket: store.bucket,
	});
}
