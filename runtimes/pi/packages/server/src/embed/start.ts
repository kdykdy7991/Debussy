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
import { createRedactingSink, createSecretRegistry, type SecretRegistry } from "../logging/redact.ts";
import { createMetricRegistry, type MetricRegistry } from "../metrics/index.ts";
import { S3ObjectStore } from "../persistence/object-store/s3.ts";
import type { ObjectStore } from "../persistence/object-store/types.ts";
import { RedisClient } from "../persistence/redis/client.ts";
import { createRedisNonceStore } from "../persistence/redis/nonce-store.ts";
import { createRedisTicketStore } from "../persistence/redis/ticket-store.ts";
import type { PublishingConfig } from "../publishing/config.ts";
import type { McpRuntimeToolFactory } from "../publishing/mcp/runtime-tools.ts";
import type { PreviewTicketService } from "../publishing/preview-ticket.ts";
import type { PublishingRepositories, UploadQuotaLimits } from "../publishing/repositories.ts";
import type { SkillMaterializer } from "../publishing/runtime/skill-materializer.ts";
import { parseRuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import { createConversationRuntimeManager } from "../runtime/conversation-runtime-manager.ts";
import {
	type BuiltinToolNameResolver,
	createPiRuntimeAdapter,
	type PiRuntimeAdapter,
	type RuntimeSessionFactory,
} from "../runtime/pi-runtime-adapter.ts";
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
import { createEmbedLimits, type EmbedLimits } from "./rate-limits/index.ts";
import { createRedisRateLimitStore } from "./rate-limits/store.ts";
import { EmbedRealtimeConnection, type RealtimeObservability } from "./realtime/connection.ts";
import { createRealtimeUpgradeHandler, type UpgradeHandler } from "./realtime/http.ts";
import { conversationRealtimeServices } from "./realtime/services.ts";
import { createTtsHttpHandler } from "./tts/http.ts";
import type { TtsProvider } from "./tts/provider.ts";
import { ttsProviderError } from "./tts/provider.ts";
import { EmbedTtsQueue } from "./tts/queue.ts";
import { createAttachmentsHttpHandler } from "./uploads/http.ts";
import { AttachmentService } from "./uploads/service.ts";

export interface EmbedPlaneOptions {
	readonly publishing: PublishingConfig;
	readonly repositories: PublishingRepositories;
	/** 底层会话工厂（真实组合接 CodingAgentPiSessionBackend.createSession）。 */
	readonly createSession: RuntimeSessionFactory;
	readonly mcpTools?: McpRuntimeToolFactory;
	/** 附件对象存储（测试注入）；缺省按 `PI_OBJECT_STORE_*` 创建 S3。 */
	readonly objectStore?: ObjectStore;
	/** 附件 bucket（与 objectStore 成对；缺省用 config.objectStore.bucket）。 */
	readonly attachmentBucket?: string;
	/**
	 * 进程级 CitationService（TASK-032；与内部会话流共用同一实例）。未提供
	 * = embed 不上传引用/检索引用（upload 仍可用，Turn 不带 retrieval）。
	 */
	readonly citations?: CitationService;
	/** 分层限流 + 并发槽（TASK-034）；缺省用 Redis store + spec 默认规则。 */
	readonly limits?: EmbedLimits;
	/** 指标注册表（TASK-035）；缺省进程单例。 */
	readonly metrics?: MetricRegistry;
	/** 敏感值注册表（TASK-035 日志脱敏）；未提供 = 内部创建并用于 redacting sink。 */
	readonly secrets?: SecretRegistry;
	/** 共享进程级 TTS Provider（TASK-036）；未提供 = speech 关闭。 */
	readonly ttsProvider?: TtsProvider;
	/** Preview ticket service (WB-005). */
	readonly previewTickets?: PreviewTicketService;
	/** Materialises frozen Skill revisions so published sessions inject them. */
	readonly skillMaterializer?: SkillMaterializer;
	/** Shared builtin Tool name resolver for `allowedToolNames` (single source). */
	readonly resolveToolName?: BuiltinToolNameResolver;
	/** Optional injected shared PiRuntimeAdapter (shared with the Debug path). */
	readonly runtimeAdapter?: PiRuntimeAdapter;
	/** Phase-3.5: resolves the deployed model's real contextWindow / maxTokens. */
	readonly resolveModelMetadata?: (
		provider: string,
		modelId: string,
	) => { readonly contextWindow: number; readonly maxTokens: number } | undefined;
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
	/** 指标注册表 + Prometheus 文本（spec 15.1；操作者可渲染/暴露）。 */
	readonly metrics: MetricRegistry;
	/** 共享 TTS 队列（TASK-036；单实例进程级）。 */
	readonly ttsQueue: EmbedTtsQueue;
	/** Published Conversation orchestration reused by thin external adapters. */
	readonly conversationService: ConversationService;
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
	readonly mcpTools?: McpRuntimeToolFactory;
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
	/** 分层限流 + 并发槽（TASK-034）；缺省用内存实现 + spec 默认规则。 */
	readonly limits?: EmbedLimits;
	/** 指标注册表（TASK-035）；缺省进程单例。 */
	readonly metrics?: MetricRegistry;
	/** 敏感值注册表（TASK-035 日志脱敏）；未提供 = 内部创建。 */
	readonly secrets?: SecretRegistry;
	/**
	 * 共享进程级 TTS Provider（TASK-036）。单个实例跨所有会话共享（不为
	 * 每用户加载模型）；未提供 = speech 端点 503（不静默假成功）。
	 */
	readonly ttsProvider?: TtsProvider;
	/** TTS 队列有界容量/超时（TASK-036；缺省 64 / 30s）。 */
	readonly tts?: { readonly maxPending?: number; readonly timeoutMs?: number };
	/** Preview ticket service (WB-005). 未提供 = preview exchange 显式 403。 */
	readonly previewTickets?: PreviewTicketService;
	/** Materialises frozen Skills so published sessions inject them (skillsOverride). */
	readonly skillMaterializer?: SkillMaterializer;
	/**
	 * Resolves builtin Tool capability ids to runtime tool names for
	 * `allowedToolNames` (single source; same resolver as the Debug path).
	 */
	readonly resolveToolName?: BuiltinToolNameResolver;
	/**
	 * Optional injected shared PiRuntimeAdapter. When absent, createEmbedServices
	 * builds one from the same factory (single builder logic in both cases).
	 */
	readonly runtimeAdapter?: PiRuntimeAdapter;
	/**
	 * Phase-3.5: resolves the deployed model's real contextWindow / maxTokens
	 * from the model registry. When absent, the budget falls back to the declared
	 * policy cap + conservative reserves (documented fallback, still safe).
	 */
	readonly resolveModelMetadata?: (
		provider: string,
		modelId: string,
	) => { readonly contextWindow: number; readonly maxTokens: number } | undefined;
}

export interface EmbedServicesHandle {
	readonly handlers: readonly HttpRequestHandler[];
	readonly realtimeUpgrade: UpgradeHandler | undefined;
	/** 供 Realtime upgrade 闭包复用（授权后的 Turn/快照）。 */
	readonly conversationService: ConversationService;
	/** 分层限流 + 并发槽（TASK-034；createEmbedServices 内部构造/透传）。 */
	readonly limits: EmbedLimits;
	/** 指标注册表 + Prometheus 文本（TASK-035）。 */
	readonly metrics: MetricRegistry;
	/** 敏感值注册表（TASK-035 日志脱敏）。 */
	readonly secrets: SecretRegistry;
	/** 共享 TTS 队列（TASK-036；单实例进程级，默认并发 1、有界队列）。 */
	readonly ttsQueue: EmbedTtsQueue;
	close(): Promise<void>;
}

/** 纯组装：Exchange + Conversations + authenticator + managed turn executor。 */
export function createEmbedServices(options: EmbedServicesOptions): EmbedServicesHandle {
	const adapter =
		options.runtimeAdapter ??
		createPiRuntimeAdapter({
			createSession: options.createSession,
			...(options.mcpTools !== undefined ? { createMcpTools: options.mcpTools } : {}),
			...(options.skillMaterializer !== undefined ? { skillMaterializer: options.skillMaterializer } : {}),
			...(options.resolveToolName !== undefined ? { resolveToolName: options.resolveToolName } : {}),
		});
	// TASK-034：分层限流 + 并发槽（缺省内存实现 + spec 默认规则；生产可从
	// compose 注入 Redis store）。暴露在 handle 上供 realtime upgrade 复用。
	const limits = options.limits ?? createEmbedLimits();
	// TASK-035：指标 + 敏感值注册表（缺省进程单例；各 handler/upgrade 用
	// `embed_*` 指标命名空间，logs 经 compose 的 redacting sink 输出）。
	const metrics = options.metrics ?? createMetricRegistry();
	const secrets = options.secrets ?? createSecretRegistry();
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
		...(options.previewTickets !== undefined ? { previewTickets: options.previewTickets } : {}),
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
		// Phase-3: after a Turn, reset the cached runtime unconditionally so the
		// next Turn rebuilds an equivalent Working Context from Postgres. This is
		// what makes a Pi-only (overflow-compacted) in-memory state impossible to
		// recycle across Turns.
		resetRuntime: (conversationId) => runtimeManager.reset(conversationId),
		resolveModelMetadata: options.resolveModelMetadata,
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

	// TASK-036：共享进程级 TTS 队列（单实例，默认并发 1、有界、超时/取消；
	// 语音故障绝不倒灌到文本 turn 路径）。providerAvailable=false 时 speech
	// 端点显式 503，不假装成功。capabilities.speech 读取（RuntimeSpec 控制）。
	const speechEnabled = async (principal: EmbedAuthContext, _conversationId: string): Promise<boolean> => {
		const app = await options.repositories.publishedApps.get(
			{ tenantId: principal.tenantId, publishedAppId: principal.publishedAppId },
			principal.publishedAppId,
		);
		if (app === undefined || app.currentVersionId === null) return false;
		const version = await options.repositories.publishedAppVersions.get(
			{ tenantId: principal.tenantId, publishedAppId: principal.publishedAppId },
			app.currentVersionId,
		);
		if (version === undefined) return false;
		const parsed = parseRuntimeSpec(version.runtimeSpec);
		return parsed.ok && parsed.spec.capabilities.speech.enabled;
	};
	const ttsQueued = metrics.gauge({ name: "embed_tts_queued", help: "TTS pending jobs" });
	const ttsRunning = metrics.gauge({ name: "embed_tts_running", help: "TTS running jobs" });
	const ttsJobs = metrics.counter({
		name: "embed_tts_jobs_total",
		help: "TTS jobs by result",
		labels: ["result"],
	});
	const ttsQueue = new EmbedTtsQueue({
		provider:
			options.ttsProvider ??
			((_input, _signal) => Promise.reject(ttsProviderError("no TTS provider configured", false))),
		maxPending: options.tts?.maxPending,
		timeoutMs: options.tts?.timeoutMs,
		onEvent: (event) => {
			const stats = ttsQueue.stats();
			ttsQueued.set(stats.pendingLocked);
			ttsRunning.set(stats.running);
			if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") {
				ttsJobs.inc({ result: event.type });
			}
		},
	});
	const ttsHandler = createTtsHttpHandler({
		authenticator,
		queue: ttsQueue,
		speechEnabled,
		providerAvailable: options.ttsProvider !== undefined,
	});

	return {
		handlers: [
			createBootstrapHttpHandler({ repositories: options.repositories }),
			createExchangeHttpHandler({ service: exchangeService, limiter: limits.limiter, metrics, secrets }),
			// uploads 必须先于 conversations 匹配（同路径前缀）。
			createAttachmentsHttpHandler({
				service: attachmentsService,
				authenticator,
				repositories: options.repositories,
				limiter: limits.limiter,
			}),
			createConversationsHttpHandler({
				service: conversationService,
				authenticator,
				repositories: options.repositories,
				...(options.wsTickets !== undefined ? { wsTickets: options.wsTickets } : {}),
				...(options.realtimeBaseUrl !== undefined ? { realtimeBaseUrl: options.realtimeBaseUrl } : {}),
				limiter: limits.limiter,
			}),
			ttsHandler,
		],
		realtimeUpgrade: options.realtimeUpgrade,
		conversationService,
		limits,
		metrics,
		secrets,
		ttsQueue,
		close: () => runtimeManager.drain(),
	};
}

/** 组合 Embed 数据面。 */
export async function composeEmbedPlane(options: EmbedPlaneOptions): Promise<EmbedPlaneHandle> {
	// TASK-035：日志经 redacting sink 输出（Token/Ticket/Key/visitorId 打码）。
	// secrets 与 createEmbedServices 共用同一注册表，handler 里注册的敏感值
	// 即刻被 sink 识别。
	const metrics = options.metrics ?? createMetricRegistry();
	const secrets = options.secrets ?? createSecretRegistry();
	const rawLog = options.log ?? console.log.bind(console);
	const log = createRedactingSink(rawLog, () => secrets.list());
	const config = await loadEmbedPlaneConfig(options.publishing);

	// 24.2：启用 Embed 数据面需要 Redis（Ticket/限流/nonce）。
	const redisUrl = options.publishing.redisUrl;
	if (redisUrl === undefined || redisUrl === "") {
		throw new Error("PI_REDIS_URL is required when publishing is enabled");
	}
	const redis = new RedisClient({ url: redisUrl });
	const wsTickets = createWsTicketService(createRedisTicketStore(redis));
	// TASK-034：分层限流 + 并发槽。生产用 Redis store（cluster-wide 计数、
	// 身份/并发故障默认 fail-closed），检查者可注入自定义实现。
	const limits = options.limits ?? createEmbedLimits({ store: createRedisRateLimitStore(redis) });
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
		...(options.mcpTools !== undefined ? { mcpTools: options.mcpTools } : {}),
		wsTickets,
		realtimeBaseUrl: options.publishing.embedBaseUrl,
		launchTokens,
		limits,
		metrics,
		secrets,
		...(options.ttsProvider !== undefined ? { ttsProvider: options.ttsProvider } : {}),
		...(objectStore !== undefined && attachmentBucket !== undefined ? { objectStore, attachmentBucket } : {}),
		uploadQuota: options.publishing.uploadQuota,
		...(options.citations !== undefined ? { citations: options.citations } : {}),
		...(options.previewTickets !== undefined ? { previewTickets: options.previewTickets } : {}),
		...(options.skillMaterializer !== undefined ? { skillMaterializer: options.skillMaterializer } : {}),
		...(options.resolveToolName !== undefined ? { resolveToolName: options.resolveToolName } : {}),
		...(options.runtimeAdapter !== undefined ? { runtimeAdapter: options.runtimeAdapter } : {}),
		...(options.resolveModelMetadata !== undefined ? { resolveModelMetadata: options.resolveModelMetadata } : {}),
	});
	// Realtime 依赖 ConversationService（由 createEmbedServices 内部构造），
	// 因此 createSession 在此闭包内通过 services 暴露的连接工厂构建。
	realtimeUpgrade = services.realtimeUpgrade;
	log("embed data plane composed: bootstrap + exchange + conversations + dev turn + realtime");

	// 组装 Realtime upgrade：消费 Ticket -> 构建 EmbedRealtimeConnection。
	// TASK-035：连接数 gauge + Turn 结果/耗时在此组装（连接不直接耦合指标名）。
	const realtimeConnections = metrics.gauge({
		name: "embed_realtime_connections",
		help: "Currently open realtime connections",
	});
	const turnTotal = metrics.counter({
		name: "embed_turn_total",
		help: "Turn outcomes",
		labels: ["result"],
	});
	const turnLatency = metrics.histogram({
		name: "embed_turn_latency",
		help: "Turn latency ms",
		buckets: [500, 1000, 2000, 5000],
	});
	const observability: RealtimeObservability = {
		onConnectionClose: () => realtimeConnections.add(-1),
		onTurnResult: (result, latencyMs) => {
			turnTotal.inc({ result });
			turnLatency.observe(latencyMs);
		},
	};
	const conversationService = services.conversationService;
	realtimeUpgrade = createRealtimeUpgradeHandler({
		wsTickets,
		limits,
		createSession: ({ ws, request, claims }) => {
			if (claims.publishedAppVersionId === null) {
				ws.close(1008, "Missing published app version");
				return;
			}
			const principal: EmbedAuthContext = {
				tokenId: claims.tokenId,
				tenantId: claims.tenantId,
				publishedAppId: claims.publishedAppId,
				principalId: claims.principalId,
				principalType: claims.principalType,
				scopes: [],
				issuedAt: new Date(),
				expiresAt: new Date(),
				publishedAppVersionId: claims.publishedAppVersionId,
			};
			realtimeConnections.add(1);
			new EmbedRealtimeConnection({
				ws,
				requestOrigin: request.headers.origin,
				claims,
				services: conversationRealtimeServices(conversationService),
				principal,
				limits,
				observability,
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
		metrics,
		ttsQueue: services.ttsQueue,
		conversationService: services.conversationService,
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
