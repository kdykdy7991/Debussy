/**
 * Embed Realtime Connection（spec 9 / TASK-025）。
 *
 * 一条已授权（Ticket 消费成功）的 WebSocket 连接：只允许操作 claims 绑定的
 * Conversation；`turn.start` 经 `RealtimeServices.executeTurn` 执行（复用
 * ConversationService：持久化 user.message + assistant.completed、单写者
 * PD-13），流式事件带 sequence；`message.completed` 永远来自持久事件
 * （流式 delta 不是唯一真相，spec 禁止条件）。Runtime 的结构化增量在生成
 * 期间实时转发，最终持久事件负责断线恢复。
 *
 * 背压：MVP 依赖 ws 库的 maxPayload/缓冲；pending bytes 限额留待 TASK-034。
 */

import {
	type Citation,
	decodeClientCommand,
	type EmbedServerEvent,
	type RealtimeDecodeError,
	type TranscriptProgress,
} from "@earendil-works/pi-protocol";
import { WebSocket } from "ws";
import type { ConversationId, RequestId, TurnId } from "../../publishing/domain/ids.ts";
import { newConversationEventId, newRequestId, parseId, toPublicId } from "../../publishing/domain/ids.ts";
import type { ConversationEventRecord, ConversationRecord } from "../../publishing/repositories.ts";
import { createEffectOwner } from "../../runtime/effect-owner.ts";
import type { TicketClaims } from "../auth/ws-ticket.ts";
import type { EmbedAuthContext } from "../middleware/authenticate.ts";
import type { EmbedLimits } from "../rate-limits/index.ts";
import type { RateLimitScope } from "../rate-limits/limiter.ts";

export type TurnOutcome =
	| {
			readonly ok: true;
			readonly turnId: TurnId;
			readonly userMessageSequence: number;
			readonly assistantSequence: number | null;
			readonly outputText: string;
			readonly thinkingText?: string;
			/** 本 turn 实际使用的引用（TASK-033；无检索为空数组）。 */
			readonly citations: readonly Citation[];
	  }
	| { readonly ok: false; readonly code: string; readonly message: string; readonly retryable: boolean };

/** Realtime 依赖（授权后的执行与快照），由 ConversationService 适配。 */
export interface RealtimeServices {
	executeTurn(input: {
		readonly principal: EmbedAuthContext;
		readonly conversationId: ConversationId;
		readonly requestId: RequestId;
		readonly text: string;
		readonly onProgress?: (progress: TranscriptProgress) => void;
	}): Promise<TurnOutcome>;
	/** 真正中止当前底层执行；仅在服务确认接受中止后才发送 turn.cancelled。 */
	cancelTurn(input: {
		readonly principal: EmbedAuthContext;
		readonly conversationId: ConversationId;
	}): Promise<{ readonly ok: true; readonly cancelled: boolean } | { readonly ok: false; readonly message: string }>;
	/** 会话最近事件序号（conversation.sync / subscribe 快照用）。 */
	getConversation(input: {
		readonly principal: EmbedAuthContext;
		readonly conversationId: ConversationId;
	}): Promise<ConversationRecord | undefined>;
	/** 断线补齐：读取 `sequence > afterSequence` 的持久事件（spec 9.2）。 */
	listEvents(input: {
		readonly principal: EmbedAuthContext;
		readonly conversationId: ConversationId;
		readonly afterSequence: number;
	}): Promise<readonly ConversationEventRecord[]>;
}

export interface EmbedRealtimeConnectionOptions {
	readonly ws: WebSocket;
	readonly requestOrigin: string | undefined;
	readonly claims: TicketClaims;
	readonly services: RealtimeServices;
	readonly principal: EmbedAuthContext;
	/** 连接关闭/异常回调（测试/日志）。 */
	readonly onClose?: (reason: string) => void;
	/** 分层限流 + 并发 Turn 槽（TASK-034）；未提供 = 不限流。 */
	readonly limits?: EmbedLimits;
	/** 指标回调（spec 15.1，TASK-035）：连接关闭 + Turn 结果/耗时。 */
	readonly observability?: RealtimeObservability;
}

/** 连接级指标回调（compose 组装，避免连接直接耦合具体指标名）。 */
export interface RealtimeObservability {
	readonly onConnectionClose: () => void;
	readonly onTurnResult: (result: "completed" | "failed" | "rate_limited", latencyMs: number) => void;
}

export const REALTIME_CLOSE_CODES = {
	policyViolation: 1008,
	protocolError: 1002,
} as const;

export class EmbedRealtimeConnection {
	private readonly ws: WebSocket;
	private readonly claims: TicketClaims;
	private readonly services: RealtimeServices;
	private readonly principal: EmbedAuthContext;
	private readonly onClose: ((reason: string) => void) | undefined;
	private readonly limits: EmbedLimits | undefined;
	private readonly observability: RealtimeObservability | undefined;
	private readonly conversationId: ConversationId;
	/** 协议消息使用 public 形式（`conv_<uuid>`），claims 存裸 UUID。 */
	private readonly publicConversationId: string;
	private closed = false;
	/** 同一连接可能收到并发 start；服务层仍是会话唯一写者，此处只用于 Stop 可用性。 */
	private activeTurnCount = 0;
	private cancellationRequested = false;

	constructor(options: EmbedRealtimeConnectionOptions) {
		this.ws = options.ws;
		this.claims = options.claims;
		this.services = options.services;
		this.principal = options.principal;
		this.onClose = options.onClose;
		this.limits = options.limits;
		this.observability = options.observability;
		this.conversationId = options.claims.conversationId;
		this.publicConversationId = toPublicId("ConversationId", this.conversationId);

		this.ws.on("message", (data) => {
			void this.handleMessage(data);
		});
		this.ws.on("close", () => {
			this.closed = true;
			this.onClose?.("closed");
		});
		this.ws.on("error", (error) => {
			this.onClose?.(`error: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	private async handleMessage(data: unknown): Promise<void> {
		if (this.closed) return;
		let raw: unknown;
		try {
			raw = JSON.parse(data instanceof Buffer ? data.toString("utf-8") : String(data));
		} catch {
			this.closeWith(REALTIME_CLOSE_CODES.protocolError, "invalid JSON");
			return;
		}
		const decoded = decodeClientCommand(raw);
		if (!decoded.ok) {
			this.closeWith(REALTIME_CLOSE_CODES.protocolError, decodeErrorDescription(decoded.error));
			return;
		}
		const command = decoded.value;
		// 只允许操作 claims 绑定的 Conversation（越权订阅/操作 = 策略违规）。
		if (command.conversationId !== this.publicConversationId) {
			this.closeWith(REALTIME_CLOSE_CODES.policyViolation, "conversation not bound to ticket");
			return;
		}
		switch (command.type) {
			case "conversation.subscribe":
				await this.handleSubscribe(command.lastSeenSequence);
				return;
			case "turn.start":
				await this.handleTurnStart(command.requestId, command.message.text);
				return;
			case "turn.cancel":
				await this.handleTurnCancel();
				return;
			case "conversation.sync":
				await this.handleSync(command.lastSeenSequence);
				return;
			case "client.ack":
				return; // ack 仅用于客户端侧去重，服务端无需处理
		}
	}

	private async handleSubscribe(lastSeenSequence: number | undefined): Promise<void> {
		const conversation = await this.services.getConversation({
			principal: this.principal,
			conversationId: this.conversationId,
		});
		if (conversation === undefined) {
			this.closeWith(REALTIME_CLOSE_CODES.policyViolation, "conversation unavailable");
			return;
		}
		this.send({
			type: "conversation.snapshot",
			...this.eventBase(lastSeenSequence ?? 0),
			payload: { lastEventSequence: conversation.lastEventSequence, status: conversation.status },
		});
	}

	private async handleTurnStart(rawRequestId: string, text: string): Promise<void> {
		const requestId = parseId("RequestId", rawRequestId) ?? newRequestId();
		this.activeTurnCount += 1;
		this.cancellationRequested = false;
		try {
			// TASK-034：先发 accepted（客户端用于回显/loading），再走限流与并发槽。
			this.send({ type: "turn.accepted", ...this.eventBase(0) });
			if (this.limits !== undefined) {
				// turn 维度分层限流（System/Tenant/App/Principal/Conversation 最严格）。
				const limited = await this.limits.limiter.check({
					dimension: "turn",
					scope: this.rateScope(),
				});
				if (!limited.allowed) {
					this.observability?.onTurnResult("rate_limited", 0);
					this.send({ type: "turn.failed", ...this.eventBase(0), error: "turn rate limit exceeded" });
					return;
				}
				// 并发槽：进程级上限；超限立即失败，不排队（禁止继续条件）。
				const slot = this.limits.turnSlots.acquire();
				if (slot === null) {
					this.observability?.onTurnResult("rate_limited", 0);
					this.send({ type: "turn.failed", ...this.eventBase(0), error: "too many concurrent turns" });
					return;
				}
				// Turn 槽必须在 EffectOwner 中释放（spec 14）：注册为 effect，LIFO
				// 在 finally 中 close，保证正常/异常/取消路径都归还槽。
				const owner = createEffectOwner();
				owner.register(() => slot.release());
				try {
					await this.runTurn(requestId, text);
				} finally {
					await owner.close();
				}
				return;
			}
			await this.runTurn(requestId, text);
		} finally {
			this.activeTurnCount -= 1;
		}
	}

	private async handleTurnCancel(): Promise<void> {
		if (this.activeTurnCount === 0) {
			this.send({ type: "turn.failed", ...this.eventBase(0), error: "no active turn to cancel" });
			return;
		}
		const result = await this.services.cancelTurn({ principal: this.principal, conversationId: this.conversationId });
		if (!result.ok) {
			this.send({ type: "turn.failed", ...this.eventBase(0), error: result.message });
			return;
		}
		if (!result.cancelled) return;
		this.cancellationRequested = true;
		this.send({ type: "turn.cancelled", ...this.eventBase(0), reason: "cancelled" });
	}

	private async runTurn(requestId: RequestId, text: string): Promise<void> {
		const startedAt = Date.now();
		const report = (result: "completed" | "failed"): void => {
			if (this.observability !== undefined) this.observability.onTurnResult(result, Date.now() - startedAt);
		};
		const outcome = await this.services.executeTurn({
			principal: this.principal,
			conversationId: this.conversationId,
			requestId,
			text,
			onProgress: (progress) => this.forwardProgress(progress),
		});
		if (this.closed) return;
		if (this.cancellationRequested) {
			this.cancellationRequested = false;
			return;
		}
		if (!outcome.ok) {
			this.send({ type: "turn.failed", ...this.eventBase(0), error: outcome.message });
			report("failed");
			return;
		}
		if (outcome.assistantSequence === null) {
			this.send({ type: "turn.failed", ...this.eventBase(0), error: "turn produced no completion" });
			report("failed");
			return;
		}
		// TASK-033：引用展示 —— 有引用先发 citation.updated（瞬时事件，sequence 0）。
		if (outcome.citations.length > 0) {
			this.send({ type: "citation.updated", ...this.eventBase(0), citations: outcome.citations });
		}
		// completed 来自持久事件；真实增量已在 Runtime 生成期间转发。
		this.send({
			type: "message.completed",
			...this.eventBase(outcome.assistantSequence),
			text: outcome.outputText,
			...(outcome.thinkingText ? { thinking: outcome.thinkingText } : {}),
		});
		report("completed");
	}

	private forwardProgress(progress: TranscriptProgress): void {
		if (this.closed) return;
		if (progress.type === "assistant_delta" && progress.kind !== "toolCall") {
			this.send({
				type: "message.delta",
				...this.eventBase(0),
				messageId: progress.messageId,
				contentIndex: progress.contentIndex,
				kind: progress.kind,
				delta: progress.delta,
			});
			return;
		}
		if (progress.type === "item_started" && progress.item.role === "tool") {
			this.send({ type: "tool.started", ...this.eventBase(0), tool: progress.item.toolName });
			return;
		}
		if (
			(progress.type === "item_updated" || progress.type === "item_finished") &&
			progress.item.role === "tool" &&
			progress.item.status !== "running"
		) {
			this.send({
				type: "tool.completed",
				...this.eventBase(0),
				tool: progress.item.toolName,
				ok: progress.item.status === "complete",
			});
		}
	}

	/** 分层限流 scope：Principal 标识 + 当前会话（conversation 层适用）。 */
	private rateScope(): RateLimitScope {
		return {
			tenantId: this.principal.tenantId,
			publishedAppId: this.principal.publishedAppId,
			principalId: this.principal.principalId,
			conversationId: this.conversationId,
		};
	}

	private async handleSync(lastSeenSequence: number): Promise<void> {
		const conversation = await this.services.getConversation({
			principal: this.principal,
			conversationId: this.conversationId,
		});
		if (conversation === undefined) {
			this.closeWith(REALTIME_CLOSE_CODES.policyViolation, "conversation unavailable");
			return;
		}
		// 断线补齐（spec 9.2）：重连后先按 lastSeenSequence 从持久事件补发
		// 已完成的 assistant.completed，再发快照进入实时流。补发只针对
		// sequence > lastSeenSequence 的事件，客户端按 sequence 去重，不重复。
		if (lastSeenSequence < conversation.lastEventSequence) {
			const events = await this.services.listEvents({
				principal: this.principal,
				conversationId: this.conversationId,
				afterSequence: lastSeenSequence,
			});
			for (const event of events) {
				if (event.eventType !== "assistant.completed" && event.eventType !== "assistant/message") continue;
				const payload = (event.payload ?? {}) as { text?: unknown; thinking?: unknown };
				this.send({
					type: "message.completed",
					...this.eventBase(event.sequence),
					text: typeof payload.text === "string" ? payload.text : "",
					...(typeof payload.thinking === "string" ? { thinking: payload.thinking } : {}),
				});
			}
		}
		this.send({
			type: "conversation.snapshot",
			...this.eventBase(lastSeenSequence),
			payload: { lastEventSequence: conversation.lastEventSequence, status: conversation.status },
		});
	}

	private eventBase(sequence: number): {
		conversationId: string;
		sequence: number;
		turnId: string | null;
		eventId: string;
		timestamp: string;
	} {
		return {
			conversationId: this.publicConversationId,
			sequence,
			turnId: null,
			eventId: newConversationEventId(),
			timestamp: new Date().toISOString(),
		};
	}

	private send(event: EmbedServerEvent): void {
		if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
		this.ws.send(JSON.stringify(event));
	}

	private closeWith(code: number, reason: string): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.ws.close(code, reason);
		} catch {
			this.ws.terminate();
		}
		this.onClose?.(reason);
		this.observability?.onConnectionClose();
	}
}

function decodeErrorDescription(error: RealtimeDecodeError): string {
	switch (error.code) {
		case "UNKNOWN_TYPE":
			return "unknown message type";
		case "NOT_OBJECT":
			return "message must be a JSON object";
		case "INVALID_FIELD":
			return `invalid field: ${error.message}`;
		case "TOO_LONG":
			return `field too long: ${error.message}`;
	}
}
