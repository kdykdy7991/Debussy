/**
 * Voice Engine 同源 WebSocket 反向代理（spec：MVP §5.1，§4.2）。
 *
 * 路径：`/api/voice-engine/v1/ws?ticket=<one-time>`。
 * 流程：消费一次性 ticket（绑 Principal/PublishedApp/TokenId/Origin）→
 * 服务端注入 upstream token 建立到 VoxEMW 的 WebSocket → 双向原样转发。
 *
 * 反代只做"安全与同源边界"，不解析 voice.ready / asr.* / tts.* 等业务协议，
 * 也不在 proxy 层维护第二套 Voice 状态机：上游关闭即关闭客户端，反之亦然。
 *
 * 本模块**不**接入 `WebSocketListener.onUnhandledUpgrade`（Task 3 处理）。
 * 本模块**不**做 SecretRegistry 注册（Task 3 处理）。
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { requestPathname } from "../../transports/websocket/listener.ts";
import type { VoiceProxyTicketService } from "../auth/voice-proxy-ticket.ts";
import type { VoiceEngineConfig } from "./config.ts";

export const VOICE_ENGINE_UPGRADE_PATH = "/api/voice-engine/v1/ws";

export interface VoiceEngineUpgradeHandle {
	readonly handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
	close(): Promise<void>;
}

export interface VoiceEngineProxyOptions {
	readonly tickets: VoiceProxyTicketService;
	readonly config: VoiceEngineConfig;
	/** 单条错误观测；Task 3 接入 redacting sink。 */
	readonly onError?: (error: unknown) => void;
}

/**
 * 创建同源 WS 反代（仅自身逻辑；接入在 Task 3）。
 *
 * 透明转发策略：
 * - `client.on('message')` → `upstream.send(data, { binary })`
 * - `upstream.on('message')` → `client.send(data, { binary })`
 * - 任一端 `close` / `error` → `terminate()` 另一端
 *
 * `binary` 标志透传：VoxEMW 与客户端均为 JSON text frame 时双方都按文本
 * 处理，但 MVP §5.2 也允许音频字段以 binary 帧发送（PCM），因此保留 binary
 * 透传是更稳的契约。
 */
export function createVoiceEngineUpgradeHandler(options: VoiceEngineProxyOptions): VoiceEngineUpgradeHandle {
	const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
	wss.on("error", (error) => options.onError?.(error));

	return {
		handleUpgrade(request, socket, head) {
			if (requestPathname(request.url) !== VOICE_ENGINE_UPGRADE_PATH) return false;
			void prepareAndUpgrade(request, socket, head);
			return true;
		},
		async close() {
			for (const client of wss.clients) client.terminate();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
		},
	};

	async function prepareAndUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		const query = new URL(request.url ?? "/", "http://voice.invalid").searchParams;
		const ticket = query.get("ticket");
		if (ticket === null || ticket === "") {
			rejectUpgrade(socket, 401, "TOKEN_INVALID", "missing ticket");
			return;
		}
		// MVP §5.1：Origin 必须存在且与签发时一致；VoiceProxyTicketClaims.origin
		// 已为 string | null，传入 undefined 会使 `?? null` 与 null 不等 → null。
		const origin = request.headers.origin;
		if (origin === undefined || origin === "") {
			rejectUpgrade(socket, 401, "TOKEN_INVALID", "missing origin");
			return;
		}
		let claims;
		try {
			claims = await options.tickets.consume(ticket, { origin });
		} catch (error) {
			options.onError?.(error);
			rejectUpgrade(socket, 503, "RUNTIME_UNAVAILABLE", "ticket store unavailable");
			return;
		}
		if (claims === null) {
			rejectUpgrade(socket, 403, "TOKEN_REPLAYED", "ticket invalid, expired or already used");
			return;
		}
		try {
			wss.handleUpgrade(request, socket, head, (client) => {
				void openUpstreamAndBridge(client);
			});
		} catch (error) {
			options.onError?.(error);
			if (!socket.destroyed) socket.destroy();
		}
	}

	async function openUpstreamAndBridge(client: WebSocket): Promise<void> {
		// 服务端注入 upstream token。`ws` 库允许 headers 选项；服务端 URL 应
		// 由 VoxEMW operator 配置为 ws/wss，不暴露于客户端。
		const upstream = new WebSocket(options.config.upstreamUrl, {
			headers: { Authorization: `Bearer ${options.config.upstreamToken}` },
		});
		let closed = false;
		let opened = false;
		const teardown = (reason: string): void => {
			if (closed) return;
			closed = true;
			options.onError?.(new Error(`voice-engine proxy teardown: ${reason}`));
			try {
				if (upstream.readyState <= WebSocket.OPEN) upstream.terminate();
			} catch {}
			try {
				if (client.readyState <= WebSocket.OPEN) client.terminate();
			} catch {}
		};

		// 握手成功后的双向透传绑定（open 之前不能转发 client 消息）。
		upstream.once("open", () => {
			opened = true;
			// client → upstream（透传 binary 标志）。
			client.on("message", (data, isBinary) => {
				if (upstream.readyState !== WebSocket.OPEN) return;
				try {
					upstream.send(data, { binary: Boolean(isBinary) });
				} catch (error) {
					options.onError?.(error);
					teardown("client->upstream send failed");
				}
			});
			// upstream → client（透传 binary 标志）。
			upstream.on("message", (data, isBinary) => {
				if (client.readyState !== WebSocket.OPEN) return;
				try {
					client.send(data, { binary: Boolean(isBinary) });
				} catch (error) {
					options.onError?.(error);
					teardown("upstream->client send failed");
				}
			});
		});

		// 任一端关闭 / 出错即收口另一端。`opened` 用于区分"握手失败"与
		// "运行时关闭"两种语义。
		client.once("close", () => teardown("client closed"));
		client.once("error", (error) => {
			options.onError?.(error);
			teardown("client error");
		});
		upstream.once("close", () => teardown(opened ? "upstream closed" : "upstream closed before open"));
		upstream.once("error", (error) => {
			options.onError?.(error);
			if (!opened) {
				// 握手阶段失败（连接被拒 / 401 / 不可达）→ 通知客户端后收口。
				try {
					if (client.readyState <= WebSocket.OPEN) client.close(1011, "upstream unavailable");
				} catch {}
				teardown("upstream handshake failed");
			} else {
				teardown("upstream error");
			}
		});
	}
}

/** 拒绝 upgrade：写 HTTP 响应后销毁。 */
function rejectUpgrade(socket: Duplex, status: number, code: string, message: string): void {
	const reason =
		status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 429 ? "Too Many Requests" : "Error";
	const body = JSON.stringify({ error: { code, message, requestId: "", retryable: false } });
	socket.write(
		`HTTP/1.1 ${status} ${reason}\r\n` +
			"Content-Type: application/json\r\n" +
			`Content-Length: ${Buffer.byteLength(body)}\r\n` +
			"Connection: close\r\n\r\n" +
			body,
	);
	socket.destroy();
}
