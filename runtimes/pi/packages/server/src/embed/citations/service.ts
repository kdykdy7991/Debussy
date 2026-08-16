/**
 * ConversationCitationService（spec 10.1 的 Citation capability adapter，TASK-032）。
 *
 * 把进程级 `CitationService`（与内部会话流共用同一实例）约束到 Embed
 * Conversation 作用域：
 *
 *  - 索引：`indexReadyAttachment` 在附件 ready 时把文本附件建成该会话的
 *    Source（`sessionId = conversationId`），字节直接来自上传缓冲（已授权，
 *    不二次读取对象存储）；非文本附件不建 source（保持 P1 直传）。
 *  - 检索：`retrieveForTurn` 以会话 `ready` 附件为授权来源枚举（全 scope
 *    repository 查询），只检索本会话的 sources——即使把其他会话的 sourceId
 *    混入也会被 `CitationService.retrieve` 的 session 过滤忽略（完成条件：
 *    引用结果只包含当前会话授权来源）。
 *  - 删除：`removeAttachment` 在附件删除时 scoped 移除 source。
 *
 * RuntimeSpec 控制是否启用引用（`citationsEnabled`）：MVP 的引用来源是
 * 会话内上传文件，`capabilities.uploads.enabled` 同时控制上传与引用——
 * uploads 关闭时没有任何 ready 附件可建 source，Turn 也不触发检索
 * （spec 5.5 冻结五个能力键，不新增第六个）。
 *
 * 本模块不依赖 AttachmentService（字节由调用方传入），可独立测试。
 */
import type { Attachment, Source } from "@earendil-works/pi-protocol";
import {
	type CitationService,
	emptyRetrievalResult,
	isTextMediaType,
	type RetrievalResult,
} from "../../citations/service.ts";
import type { AttachmentId, TurnId } from "../../publishing/domain/ids.ts";
import type { AttachmentRecord, ConversationScope, PublishingRepositories } from "../../publishing/repositories.ts";
import type { RuntimeSpec } from "../../publishing/runtime-spec/schema.ts";

export interface ConversationCitationServiceOptions {
	/** 进程级 CitationService（embed 与内部会话流共用）。 */
	readonly citations: CitationService;
	/** 附件 repository：会话 ready 附件是引用的授权来源枚举。 */
	readonly repositories: PublishingRepositories;
}

export class ConversationCitationService {
	private readonly citations: CitationService;
	private readonly repositories: PublishingRepositories;

	constructor(options: ConversationCitationServiceOptions) {
		this.citations = options.citations;
		this.repositories = options.repositories;
	}

	/**
	 * RuntimeSpec 控制是否启用引用：uploads 能力同时控制上传与引用
	 * （MVP 引用来源 = 会话内上传文件）。纯函数便于测试与 gate 断言。
	 */
	citationsEnabled(spec: RuntimeSpec): boolean {
		return spec.capabilities.uploads.enabled;
	}

	/** 索引一个刚 ready 的会话附件（文本类型才建 source；幂等，可安全并发）。 */
	async indexReadyAttachment(scope: ConversationScope, record: AttachmentRecord, data: Buffer): Promise<void> {
		if (!isTextMediaType(record.contentType)) return;
		const attachment: Attachment = {
			id: record.attachmentId,
			sessionId: record.conversationId,
			name: record.filename,
			mediaType: record.contentType,
			size: record.sizeBytes,
			sha256: record.checksumSha256,
			status: "ready",
			createdAt: record.createdAt.getTime(),
		};
		await this.citations.ensureConversationSource(scope, attachment, data);
	}

	/** 会话级检索：只考虑本会话 ready 附件的 sources。 */
	async retrieveForTurn(scope: ConversationScope, query: string, turnId: TurnId): Promise<RetrievalResult> {
		const records = await this.repositories.attachments.listReadyByConversation(scope);
		const sourceIds: string[] = [];
		for (const record of records) {
			const source = this.citations.getConversationSourceByAttachment(scope, record.attachmentId);
			if (source !== undefined && source.status === "ready") sourceIds.push(source.id);
		}
		if (sourceIds.length === 0) return emptyRetrievalResult();
		return this.citations.retrieveForConversation(scope, { sourceIds, query, turnId });
	}

	/** 附件删除时移除其 source（scoped，幂等）。 */
	async removeAttachment(scope: ConversationScope, attachmentId: AttachmentId): Promise<void> {
		await this.citations.removeConversationSource(scope, attachmentId);
	}

	/** 会话 sources（测试/可观测）。 */
	listSources(scope: ConversationScope): Source[] {
		return this.citations.listConversationSources(scope);
	}
}
