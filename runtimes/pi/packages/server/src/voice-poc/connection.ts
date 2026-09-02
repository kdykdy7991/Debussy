import type { RawData } from "ws";
import type { ConversationService } from "../embed/conversations/service.ts";
import type { EmbedAuthContext } from "../embed/middleware/authenticate.ts";
import type { ConversationId } from "../publishing/domain/ids.ts";

export interface VoicePocTransport {
	send(payload: string): void;
	onMessage(listener: (data: RawData) => void): void;
	onClose(listener: () => void): void;
}

export interface VoicePocConnectionOptions {
	readonly transport: VoicePocTransport;
	readonly service: Pick<ConversationService, "executeTurn">;
	readonly principal: EmbedAuthContext;
	readonly conversationId: ConversationId;
}

export class VoicePocConnection {
	private readonly transport: VoicePocTransport;
	private readonly service: Pick<ConversationService, "executeTurn">;
	private readonly principal: EmbedAuthContext;
	private readonly conversationId: ConversationId;
	private turnRunning = false;
	private closed = false;

	constructor(options: VoicePocConnectionOptions) {
		this.transport = options.transport;
		this.service = options.service;
		this.principal = options.principal;
		this.conversationId = options.conversationId;
		this.transport.onMessage((data) => void this.handleMessage(data));
		this.transport.onClose(() => {
			this.closed = true;
		});
	}

	private async handleMessage(data: RawData): Promise<void> {
		let input: unknown;
		try {
			input = JSON.parse(rawDataText(data));
		} catch {
			this.sendError("invalid JSON");
			return;
		}
		if (!isTurnStart(input)) {
			this.sendError("expected turn.start with non-empty text");
			return;
		}
		if (this.turnRunning) {
			this.sendError("turn already running");
			return;
		}
		this.turnRunning = true;
		try {
			const result = await this.service.executeTurn({
				principal: this.principal,
				conversationId: this.conversationId,
				text: input.text,
				onProgress: (progress) => {
					if (progress.type === "assistant_delta" && progress.kind === "text" && progress.delta !== "") {
						this.send({ type: "text.delta", text: progress.delta });
					}
				},
			});
			if (!result.ok) {
				this.sendError(result.error.message);
				return;
			}
			this.send({ type: "text.done" });
		} catch {
			this.sendError("turn execution failed");
		} finally {
			this.turnRunning = false;
		}
	}

	private send(
		payload: { readonly type: "text.delta"; readonly text: string } | { readonly type: "text.done" },
	): void {
		if (!this.closed) this.transport.send(JSON.stringify(payload));
	}

	private sendError(message: string): void {
		if (!this.closed) this.transport.send(JSON.stringify({ type: "error", message }));
	}
}

function rawDataText(data: RawData): string {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
	return data.toString("utf8");
}

function isTurnStart(value: unknown): value is { readonly type: "turn.start"; readonly text: string } {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return record.type === "turn.start" && typeof record.text === "string" && record.text.trim() !== "";
}
