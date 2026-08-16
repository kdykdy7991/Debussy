/**
 * Embed Attachment Service（spec 27.5 / 13.3，TASK-030/031）。
 *
 * 上传流程：读会话固定版本 -> scan（大小/扩展/文件头/checksum，单文件上限
 * 取 RuntimeSpec capabilities.uploads.maxFileBytes）-> 事务内原子预留
 * `reserveStaged`（锁会话行 + 三档总量配额 + 插入 staged）-> `putObject`
 * -> `statObject` 校验字节数 -> 标记 ready。任一步失败即补偿
 * （removeObject + 标记 rejected），绝不让对象存储残留不可信文件或悬空记录。
 *
 * 配额（spec 14 / TASK-031）：单次 maxFiles（MVP 单请求单文件）、单会话 /
 * Principal / App 字节总量（staged+ready 计入，deleted/rejected 不计；
 * 删除与清理后额度回收）。上传前检查发生在**同一事务**的锁内，并发上传
 * 同一会话不会同时越过会话配额。
 *
 * 读取（TASK-031 完成条件「猜中 Attachment ID 也无法探测或使用」）：所有
 * 读取经 `get`/`getContent` 全 scope 校验（tenant/app/principal/conversation），
 * 越权一律统一不可用；禁止任何按裸 attachmentId 的读取路径。
 *
 * 删除是幂等的（重复删除一律成功）；过期清理（sweepExpired）把「过期的
 * ready + 超龄的 staged」从对象存储移除并标记 deleted（spec 6.3）。
 * 生产路径只依赖对象存储，不依赖节点磁盘永久保存（spec 24.1 / WP-08）。
 */
import type { ObjectStore } from "../../persistence/object-store/types.ts";
import {
	conversationNotFound,
	type EmbedError,
	quotaExceeded,
	runtimeUnavailable,
	uploadRejected,
} from "../../publishing/domain/errors.ts";
import {
	type AttachmentId,
	type ConversationId,
	newAttachmentId,
	type PublishedAppVersionId,
} from "../../publishing/domain/ids.ts";
import type {
	AttachmentRecord,
	ConversationScope,
	OwnerScope,
	PublishingRepositories,
	UploadQuotaLimits,
} from "../../publishing/repositories.ts";
import { parseRuntimeSpec } from "../../publishing/runtime-spec/schema.ts";
import type { ConversationCitationService } from "../citations/service.ts";
import type { EmbedAuthContext } from "../middleware/authenticate.ts";
import { EMBED_MAX_FILE_BYTES, scanUpload, sha256Hex } from "./scan.ts";

export type AttachmentServiceResult<T> =
	| { readonly ok: true; readonly data: T }
	| { readonly ok: false; readonly error: EmbedError };

export interface UploadAttachmentInput {
	readonly principal: EmbedAuthContext;
	readonly conversationId: ConversationId;
	readonly filename: string;
	readonly declaredContentType: string | undefined;
	readonly declaredChecksumSha256: string | undefined;
	readonly data: Buffer;
}

/** 对外响应视图（不含 objectKey —— 对象存储路径对客户端透明）。 */
export interface AttachmentView {
	readonly attachmentId: string;
	readonly conversationId: string;
	readonly status: AttachmentRecord["status"];
	readonly filename: string;
	readonly contentType: string;
	readonly sizeBytes: number;
	readonly checksumSha256: string;
	readonly createdAt: string;
}

/** 读取返回（含对象字节；供 HTTP GET 与后续 Realtime/模型引用校验）。 */
export interface AttachmentContent {
	readonly attachmentId: string;
	readonly filename: string;
	readonly contentType: string;
	readonly sizeBytes: number;
	readonly checksumSha256: string;
	readonly data: Buffer;
}

export interface AttachmentServiceOptions {
	readonly repositories: PublishingRepositories;
	readonly objectStore: ObjectStore;
	readonly bucket: string;
	/**
	 * 单文件上限兜底；**优先取会话固定版本的 RuntimeSpec
	 * capabilities.uploads.maxFileBytes**（TASK-031），spec 缺失时才用此值。
	 */
	readonly maxFileBytes?: number;
	/** 上传总量配额（TASK-031）；缺省用平台默认（config DEFAULT_UPLOAD_QUOTA）。 */
	readonly quota?: Partial<UploadQuotaLimits>;
	/** 过期 staged 的清扫年龄；默认 24 小时。 */
	readonly stagedTtlMs?: number;
	/**
	 * 会话级引用能力（TASK-032）：附件 ready 时后台索引文本 source，
	 * 删除时 scoped 移除 source。未提供 = 上传不建引用索引。
	 */
	readonly citations?: ConversationCitationService;
	readonly onError?: (error: unknown) => void;
}

export const DEFAULT_ATTACHMENT_QUOTA: UploadQuotaLimits = {
	conversationBytes: 100 * 1024 * 1024,
	principalBytes: 500 * 1024 * 1024,
	appBytes: 2 * 1024 * 1024 * 1024,
};

export class AttachmentService {
	private readonly repositories: PublishingRepositories;
	private readonly objectStore: ObjectStore;
	private readonly bucket: string;
	private readonly maxFileBytes: number;
	private readonly quota: UploadQuotaLimits;
	private readonly stagedTtlMs: number;
	private readonly citations: ConversationCitationService | undefined;
	private readonly onError?: (error: unknown) => void;

	constructor(options: AttachmentServiceOptions) {
		this.repositories = options.repositories;
		this.objectStore = options.objectStore;
		this.bucket = options.bucket;
		this.maxFileBytes = options.maxFileBytes ?? EMBED_MAX_FILE_BYTES;
		this.quota = { ...DEFAULT_ATTACHMENT_QUOTA, ...options.quota };
		this.stagedTtlMs = options.stagedTtlMs ?? 24 * 60 * 60 * 1000;
		this.citations = options.citations;
		this.onError = options.onError;
	}

	/**
	 * 上传并转为 ready。scope = (tenant, app, principal, conversation)：
	 * 会话不可见/越权 -> 统一 CONVERSATION_NOT_FOUND；超配额 -> QUOTA_EXCEEDED
	 * (429 retryable)；单文件超版本上限 / 上传未启用 -> UPLOAD_REJECTED (422)。
	 */
	async upload(input: UploadAttachmentInput): Promise<AttachmentServiceResult<AttachmentView>> {
		const ownerScope: OwnerScope = {
			tenantId: input.principal.tenantId,
			publishedAppId: input.principal.publishedAppId,
			principalId: input.principal.principalId,
		};
		const conversation = await this.repositories.conversations.get(ownerScope, input.conversationId);
		if (conversation === undefined) {
			return { ok: false, error: conversationNotFound() };
		}
		// 会话固定版本是上传能力的权威来源（spec 5.5 / PD-09）：enabled、
		// maxFiles、maxFileBytes 均以版本 spec 为准；spec 缺失时保守拒绝。
		const uploadsCapability = await this.uploadsCapability(conversation.publishedAppVersionId, ownerScope);
		if (uploadsCapability === undefined || !uploadsCapability.enabled) {
			return { ok: false, error: uploadRejected("Uploads are not enabled for this app version") };
		}

		const scan = scanUpload({
			data: input.data,
			filename: input.filename,
			declaredContentType: input.declaredContentType,
			declaredChecksumSha256: input.declaredChecksumSha256,
			maxFileBytes: uploadsCapability.maxFileBytes,
		});
		if (!scan.ok) {
			return { ok: false, error: uploadRejected(`Upload rejected: ${scan.reason}`) };
		}

		const scope: ConversationScope = {
			...ownerScope,
			conversationId: input.conversationId,
		};
		const attachmentId = newAttachmentId();
		// 服务端生成 objectKey；文件名绝不进入 key（TASK-030 禁止条件）。
		const objectKey = `attachments/${input.principal.tenantId}/${input.principal.publishedAppId}/${attachmentId}`;
		const record: AttachmentRecord = {
			attachmentId,
			tenantId: input.principal.tenantId,
			publishedAppId: input.principal.publishedAppId,
			conversationId: input.conversationId,
			ownerPrincipalId: input.principal.principalId,
			objectKey,
			filename: input.filename,
			contentType: scan.mediaType,
			sizeBytes: input.data.length,
			checksumSha256: scan.checksumSha256,
			status: "staged",
			expiresAt: null,
			createdAt: new Date(),
		};
		// TASK-031：事务内锁会话行 + 三档配额检查 + 插入 staged（原子）。
		const reserved = await this.repositories.attachments.reserveStaged(scope, record, this.quota);
		if (reserved.outcome === "conversation_missing") {
			return { ok: false, error: conversationNotFound() };
		}
		if (reserved.outcome === "quota_exceeded") {
			return { ok: false, error: quotaExceeded("Upload quota exceeded") };
		}

		// 写入对象存储；失败 -> 补偿为 rejected（staged 已可见，不悬空）。
		try {
			await this.objectStore.putObject({
				bucket: this.bucket,
				objectKey,
				data: input.data,
				size: input.data.length,
				contentType: scan.mediaType,
			});
		} catch (error) {
			this.onError?.(error);
			await this.markRejected(scope, attachmentId);
			return { ok: false, error: runtimeUnavailable("Attachment storage is temporarily unavailable") };
		}

		// 校验落地字节数；不符 -> 删除对象并标记 rejected（失败补偿）。
		try {
			const metadata = await this.objectStore.statObject({ bucket: this.bucket, objectKey });
			if (metadata.size !== input.data.length) {
				await this.cleanupObject(objectKey);
				await this.markRejected(scope, attachmentId);
				return { ok: false, error: uploadRejected("Upload rejected: stored size mismatch") };
			}
		} catch (error) {
			this.onError?.(error);
			await this.cleanupObject(objectKey);
			await this.markRejected(scope, attachmentId);
			return { ok: false, error: runtimeUnavailable("Attachment storage is temporarily unavailable") };
		}

		await this.repositories.attachments.updateStatus(scope, attachmentId, "ready");
		// TASK-032：后台索引文本附件为会话 source（幂等）；索引失败不影响
		// 上传结果（source 保持 pending/failed，检索时被忽略）。
		if (this.citations !== undefined) {
			void this.citations.indexReadyAttachment(scope, record, input.data).catch((error: unknown) => {
				this.onError?.(error);
			});
		}
		return { ok: true, data: this.toView(record, "ready") };
	}

	/**
	 * 读取（TASK-031）：全 scope 校验（tenant/app/principal/conversation），
	 * 越权/不存在 -> 统一 CONVERSATION_NOT_FOUND 语义（404）。只有 `ready`
	 * 附件可读；对象缺失 -> RUNTIME_UNAVAILABLE。
	 */
	async getContent(
		principal: EmbedAuthContext,
		conversationId: ConversationId,
		attachmentId: AttachmentId,
	): Promise<AttachmentServiceResult<AttachmentContent>> {
		const scope: ConversationScope = {
			tenantId: principal.tenantId,
			publishedAppId: principal.publishedAppId,
			principalId: principal.principalId,
			conversationId,
		};
		const record = await this.repositories.attachments.get(scope, attachmentId);
		if (record === undefined || record.status !== "ready") {
			return { ok: false, error: conversationNotFound() };
		}
		try {
			const data = await this.objectStore.getObject({ bucket: this.bucket, objectKey: record.objectKey });
			return {
				ok: true,
				data: {
					attachmentId: record.attachmentId,
					filename: record.filename,
					contentType: record.contentType,
					sizeBytes: record.sizeBytes,
					checksumSha256: record.checksumSha256,
					data,
				},
			};
		} catch (error) {
			this.onError?.(error);
			return { ok: false, error: runtimeUnavailable("Attachment storage is temporarily unavailable") };
		}
	}

	/** 幂等删除：越权/不存在也返回成功（资源对任何调用者都不可见）。 */
	async delete(
		principal: EmbedAuthContext,
		conversationId: ConversationId,
		attachmentId: AttachmentId,
	): Promise<AttachmentServiceResult<{ readonly attachmentId: string; readonly deleted: boolean }>> {
		const scope: ConversationScope = {
			tenantId: principal.tenantId,
			publishedAppId: principal.publishedAppId,
			principalId: principal.principalId,
			conversationId,
		};
		const record = await this.repositories.attachments.get(scope, attachmentId);
		if (record === undefined) {
			return { ok: true, data: { attachmentId, deleted: false } };
		}
		await this.cleanupObject(record.objectKey);
		await this.repositories.attachments.updateStatus(scope, attachmentId, "deleted");
		// TASK-032：附件删除后其 source 不再参与引用（scoped、幂等；失败只
		// 记录，不改变删除结果——检索的来源枚举来自 DB ready 附件）。
		if (this.citations !== undefined) {
			await this.citations.removeAttachment(scope, attachmentId).catch((error: unknown) => {
				this.onError?.(error);
			});
		}
		return { ok: true, data: { attachmentId, deleted: true } };
	}

	/**
	 * 过期清理（spec 6.3）：超龄 staged + 过期的 ready 从对象存储移除并标记
	 * deleted。返回清理行数；单次分批（listSweepCandidates 上限）。
	 */
	async sweepExpired(limit = 100): Promise<number> {
		const now = new Date();
		const candidates = await this.repositories.attachments.listSweepCandidates({
			limit,
			stagedBefore: new Date(now.getTime() - this.stagedTtlMs),
			readyExpiredBefore: now,
		});
		let swept = 0;
		for (const record of candidates) {
			await this.cleanupObject(record.objectKey);
			const scope: ConversationScope = {
				tenantId: record.tenantId,
				publishedAppId: record.publishedAppId,
				principalId: record.ownerPrincipalId,
				conversationId: record.conversationId,
			};
			const done = await this.repositories.attachments.updateStatus(scope, record.attachmentId, "deleted");
			if (done) swept += 1;
		}
		return swept;
	}

	/** 校验对象存储中确无残留（供测试断言；不对外暴露 objectKey）。 */
	async objectExists(objectKey: string): Promise<boolean> {
		try {
			await this.objectStore.statObject({ bucket: this.bucket, objectKey });
			return true;
		} catch {
			return false;
		}
	}

	/** 供 Realtime/turn 引用校验使用的对象字节数（测试/后续任务）。 */
	async statObjectBytes(objectKey: string): Promise<number | undefined> {
		try {
			const metadata = await this.objectStore.statObject({ bucket: this.bucket, objectKey });
			return metadata.size;
		} catch {
			return undefined;
		}
	}

	/** 会话内活跃（staged+ready）字节总量（测试断言额度回收）。 */
	async activeConversationBytes(principal: EmbedAuthContext, conversationId: ConversationId): Promise<number> {
		return this.repositories.attachments.sumActiveBytes({
			tenantId: principal.tenantId,
			publishedAppId: principal.publishedAppId,
			principalId: principal.principalId,
			conversationId,
		});
	}

	private async uploadsCapability(
		versionId: PublishedAppVersionId,
		scope: OwnerScope,
	): Promise<{ readonly enabled: boolean; readonly maxFiles: number; readonly maxFileBytes: number } | undefined> {
		const version = await this.repositories.publishedAppVersions.get(scope, versionId);
		if (version === undefined) return undefined;
		const parsed = parseRuntimeSpec(version.runtimeSpec);
		if (!parsed.ok) return undefined;
		return parsed.spec.capabilities.uploads;
	}

	private async markRejected(scope: ConversationScope, attachmentId: AttachmentId): Promise<void> {
		await this.repositories.attachments.updateStatus(scope, attachmentId, "rejected");
	}

	private async cleanupObject(objectKey: string): Promise<void> {
		try {
			await this.objectStore.removeObject({ bucket: this.bucket, objectKey });
		} catch (error) {
			this.onError?.(error);
		}
	}

	private toView(record: AttachmentRecord, status: AttachmentRecord["status"]): AttachmentView {
		return {
			attachmentId: record.attachmentId,
			conversationId: record.conversationId,
			status,
			filename: record.filename,
			contentType: record.contentType,
			sizeBytes: record.sizeBytes,
			checksumSha256: record.checksumSha256,
			createdAt: record.createdAt.toISOString(),
		};
	}
}

/** 供 HTTP 层与测试计算请求级校验和。 */
export { sha256Hex };
