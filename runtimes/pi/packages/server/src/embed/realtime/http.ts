/**
 * Embed Realtime Upgrade Handler（spec 27.6 / TASK-025）。
 *
 * `GET /api/embed/v1/realtime?ticket=<oneTimeTicket>`：消费一次性 Ticket
 * （原子 get+del，重放/过期/Origin 不匹配拒绝 upgrade），成功后升级为
 * WebSocket 并交给 `createSession` 构建 Realtime 连接。Ticket 在 query 中
 * 可接受（短 TTL + 单次），但长效 Access Token 绝不能出现在 URL（禁止继续
 * 条件）；query 脱敏由网关访问日志策略负责（TASK-035）。
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { requestPathname } from "../../transports/websocket/listener.ts";
import type { TicketClaims, WsTicketService } from "../auth/ws-ticket.ts";
import type { EmbedLimits } from "../rate-limits/index.ts";

export const REALTIME_UPGRADE_PATH = "/api/embed/v1/realtime";

export interface RealtimeUpgradeHandlerOptions {
	readonly wsTickets: WsTicketService;
	/** 构建并接管一条已授权的连接（claims 为已消费 Ticket 的绑定信息）。 */
	readonly createSession: (session: {
		readonly ws: WebSocket;
		readonly request: IncomingMessage;
		readonly claims: WsTicketService extends never ? never : import("../auth/ws-ticket.ts").TicketClaims;
	}) => void;
	readonly maxPayload?: number;
	readonly onError?: (error: unknown) => void;
	/** 分层限流 + 并发槽（TASK-034）：连接维度计数，超限拒绝 upgrade。 */
	readonly limits?: EmbedLimits;
}

export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;

export function createRealtimeUpgradeHandler(options: RealtimeUpgradeHandlerOptions): UpgradeHandler {
	const wss = new WebSocketServer({ noServer: true, maxPayload: options.maxPayload ?? 256 * 1024 });
	wss.on("error", (error) => options.onError?.(error));

	return (request, socket, head): boolean => {
		const pathname = requestPathname(request.url);
		if (pathname !== REALTIME_UPGRADE_PATH) return false;
		void handleUpgrade(request, socket, head);
		return true;
	};

	async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		const query = new URL(request.url ?? "/", "http://embed.invalid").searchParams;
		const ticket = query.get("ticket");
		if (ticket === null || ticket === "") {
			rejectUpgrade(socket, 401, "TOKEN_INVALID", "missing ticket");
			return;
		}
		let claims: TicketClaims | null;
		try {
			claims = await options.wsTickets.consume(ticket, { origin: request.headers.origin });
		} catch (error) {
			options.onError?.(error);
			rejectUpgrade(socket, 503, "RUNTIME_UNAVAILABLE", "ticket store unavailable");
			return;
		}
		if (claims === null) {
			rejectUpgrade(socket, 403, "TOKEN_REPLAYED", "ticket invalid, expired or already used");
			return;
		}
		// TASK-034：连接维度分层限流——超限拒绝 upgrade（不占用宝贵连接）。
		if (options.limits !== undefined) {
			const allowed = await options.limits.limiter.check({
				dimension: "connections",
				scope: {
					tenantId: claims.tenantId,
					publishedAppId: claims.publishedAppId,
					principalId: claims.principalId,
				},
			});
			if (!allowed.allowed) {
				rejectUpgrade(socket, 429, "RATE_LIMITED", "too many connections");
				return;
			}
		}
		try {
			wss.handleUpgrade(request, socket, head, (webSocket) => {
				options.createSession({ ws: webSocket, request, claims });
			});
		} catch (error) {
			options.onError?.(error);
			socket.destroy();
		}
	}
}

/** 拒绝 upgrade：写 HTTP 响应后销毁 socket。 */
function rejectUpgrade(socket: Duplex, status: number, code: string, message: string): void {
	const reason =
		status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 429 ? "Too Many Requests" : "Error";
	const body = JSON.stringify({
		error: { code, message, requestId: "", retryable: status === 429 },
	});
	socket.write(
		`HTTP/1.1 ${status} ${reason}\r\n` +
			"Content-Type: application/json\r\n" +
			`Content-Length: ${Buffer.byteLength(body)}\r\n` +
			"Connection: close\r\n\r\n" +
			body,
	);
	socket.destroy();
}
