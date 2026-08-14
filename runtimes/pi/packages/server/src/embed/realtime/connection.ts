/**
 * Embed Realtime Connection（spec 9 / TASK-025）。
 *
 * 一条已授权（Ticket 消费成功）的 WebSocket 连接：只允许操作 claims 绑定的
 * Conversation；`turn.start` 经 `RealtimeServices.executeTurn` 执行（复用
 * ConversationService：持久化 user.message + assistant.completed、单写者
 * PD-13），流式事件带 sequence；`message.completed` 永远来自持久事件
 * （流式 delta 不是唯一真相，spec 禁止条件）。MVP 的 delta 为单帧全文
 * （Realtime 正式流式由后续优化补充，事件语义已冻结）。
 *
 * 背压：MVP 依赖 ws 库的 maxPayload/缓冲；pending bytes 限额留待 TASK-034。
 */

import { decodeClientCommand, type EmbedServerEvent, type RealtimeDecodeError } from "@earendil-works/pi-protocol";
import { WebSocket } from "ws";
import type { ConversationId, TurnId } from "../../publishing/domain/ids.ts";
import { newConversationEventId, toPublicId } from "../../publishing/domain/ids.ts";
import type { ConversationEventRecord, ConversationRecord } from "../../publishing/repositories.ts";
import type { TicketClaims } from "../auth/ws-ticket.ts";
import type { EmbedAuthContext } from "../middleware/authenticate.ts";

export type TurnOutcome =
	| {
			readonly ok: true;
			readonly turnId: TurnId;
			readonly userMessageSequence: number;
			readonly assistantSequence: number | null;
			readonly outputText: string;
	  }
	| { readonly ok: false; readonly code: string; readonly message: string; readonly retryable: boolean };

/** Realtime 依赖（授权后的执行与快照），由 ConversationService 适配。 */
export interface RealtimeServices {
	executeTurn(input: {
		readonly principal: EmbedAuthContext;
		readonly conversationId: ConversationId;
		readonly text: string;
	}): Promise<TurnOutcome>;
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
	private readonly conversationId: ConversationId;
	/** 协议消息使用 public 形式（`conv_<uuid>`），claims 存裸 UUID。 */
	private readonly publicConversationId: string;
	private closed = false;

	constructor(options: EmbedRealtimeConnectionOptions) {
		this.ws = options.ws;
		this.claims = options.claims;
		this.services = options.services;
		this.principal = options.principal;
		this.onClose = options.onClose;
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
				this.send({ type: "turn.cancelled", ...this.eventBase(0), reason: "cancelled" });
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

	private async handleTurnStart(_requestId: string, text: string): Promise<void> {
		this.send({ type: "turn.accepted", ...this.eventBase(0) });
		const outcome = await this.services.executeTurn({
			principal: this.principal,
			conversationId: this.conversationId,
			text,
		});
		if (this.closed) return;
		if (!outcome.ok) {
			this.send({ type: "turn.failed", ...this.eventBase(0), error: outcome.message });
			return;
		}
		if (outcome.assistantSequence === null) {
			this.send({ type: "turn.failed", ...this.eventBase(0), error: "turn produced no completion" });
			return;
		}
		// MVP：delta 单帧全文；completed 来自持久事件（sequence = 持久序号）。
		this.send({ type: "message.delta", ...this.eventBase(outcome.assistantSequence), text: outcome.outputText });
		this.send({ type: "message.completed", ...this.eventBase(outcome.assistantSequence), text: outcome.outputText });
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
				if (event.eventType !== "assistant.completed") continue;
				const payload = (event.payload ?? {}) as { text?: unknown };
				this.send({
					type: "message.completed",
					...this.eventBase(event.sequence),
					text: typeof payload.text === "string" ? payload.text : "",
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
