import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { ConversationService } from "../embed/conversations/service.ts";
import type { EmbedAuthContext } from "../embed/middleware/authenticate.ts";
import { newPrincipalId, type TenantId } from "../publishing/domain/ids.ts";
import type { PublishedAppRecord, PublishingRepositories } from "../publishing/repositories.ts";
import { parseRuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import { requestPathname } from "../transports/websocket/listener.ts";
import type { VoicePocConfig } from "./config.ts";
import { VoicePocConnection } from "./connection.ts";

export const VOICE_POC_PATH = "/api/voice-poc/v1/ws";

export interface VoicePocUpgradeHandle {
	readonly handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
	close(): Promise<void>;
}

export function createVoicePocUpgradeHandler(options: {
	readonly config: VoicePocConfig;
	readonly tenantId: TenantId;
	readonly repositories: PublishingRepositories;
	readonly conversationService: ConversationService;
	readonly onError?: (error: unknown) => void;
}): VoicePocUpgradeHandle {
	const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
	wss.on("error", (error) => options.onError?.(error));

	return {
		handleUpgrade(request, socket, head) {
			if (requestPathname(request.url) !== VOICE_POC_PATH) return false;
			void prepareAndUpgrade(request, socket, head);
			return true;
		},
		async close() {
			for (const client of wss.clients) client.terminate();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
		},
	};

	async function prepareAndUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		if (!matchesBearer(request, options.config.token)) {
			rejectUpgrade(socket, 401, "unauthorized");
			return;
		}
		try {
			const apps = await enabledVoiceApps();
			if (apps.length !== 1) {
				rejectUpgrade(socket, 503, "exactly one published Agent must enable experimental realtime voice");
				return;
			}
			const app = apps[0];
			if (app === undefined || app.status !== "active" || app.currentVersionId === null) {
				rejectUpgrade(socket, 503, "voice POC Agent is not published and active");
				return;
			}
			const now = new Date();
			const principal = await options.repositories.principals.upsert({
				principalId: newPrincipalId(),
				tenantId: options.tenantId,
				publishedAppId: app.publishedAppId,
				principalType: "service",
				subjectHash: createHash("sha256")
					.update(`voice-poc\n${options.tenantId}\n${app.publishedAppId}`, "utf8")
					.digest("hex"),
				status: "active",
				createdAt: now,
				lastSeenAt: now,
			});
			if (principal.status !== "active") {
				rejectUpgrade(socket, 503, "voice POC principal unavailable");
				return;
			}
			const auth: EmbedAuthContext = {
				tokenId: "voice-poc",
				tenantId: options.tenantId,
				publishedAppId: app.publishedAppId,
				principalId: principal.principalId,
				principalType: "service",
				scopes: [],
				issuedAt: now,
				expiresAt: new Date(8640000000000000),
				publishedAppVersionId: app.currentVersionId,
			};
			const created = await options.conversationService.createConversation({
				principal: auth,
				title: "Voice POC",
			});
			if (!created.ok) {
				rejectUpgrade(socket, 503, "voice POC conversation unavailable");
				return;
			}
			wss.handleUpgrade(request, socket, head, (webSocket) => {
				new VoicePocConnection({
					transport: {
						send: (payload) => webSocket.send(payload),
						onMessage: (listener) => webSocket.on("message", listener),
						onClose: (listener) => webSocket.on("close", listener),
					},
					service: options.conversationService,
					principal: auth,
					conversationId: created.data.conversation.conversationId,
				});
			});
		} catch (error) {
			options.onError?.(error);
			if (!socket.destroyed) rejectUpgrade(socket, 503, "voice POC unavailable");
		}
	}

	async function enabledVoiceApps(): Promise<PublishedAppRecord[]> {
		const enabled: PublishedAppRecord[] = [];
		let cursor: string | undefined;
		do {
			const rows = await options.repositories.publishedApps.list({
				scope: { tenantId: options.tenantId },
				limit: 100,
				...(cursor === undefined ? {} : { cursor }),
				status: "active",
			});
			for (const app of rows) {
				if (app.currentVersionId === null) continue;
				const version = await options.repositories.publishedAppVersions.get(
					{ tenantId: options.tenantId, publishedAppId: app.publishedAppId },
					app.currentVersionId,
				);
				const parsed = parseRuntimeSpec(version?.runtimeSpec);
				if (parsed.ok && parsed.spec.capabilities.realtimeVoice.enabled) enabled.push(app);
			}
			cursor = rows.length === 100 ? rows[rows.length - 1]?.cursor : undefined;
		} while (cursor !== undefined);
		return enabled;
	}
}

function matchesBearer(request: IncomingMessage, expected: string): boolean {
	const match = (request.headers.authorization ?? "").match(/^Bearer\s+(.+)$/);
	if (match === null || match[1] === undefined) return false;
	const actual = Buffer.from(match[1].trim());
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function rejectUpgrade(socket: Duplex, status: 401 | 503, message: string): void {
	const reason = status === 401 ? "Unauthorized" : "Service Unavailable";
	const body = JSON.stringify({ type: "error", message });
	socket.write(
		`HTTP/1.1 ${status} ${reason}\r\n` +
			"Content-Type: application/json\r\n" +
			`Content-Length: ${Buffer.byteLength(body)}\r\n` +
			"Connection: close\r\n\r\n" +
			body,
	);
	socket.destroy();
}
