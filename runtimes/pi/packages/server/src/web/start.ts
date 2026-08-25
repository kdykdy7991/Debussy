/**
 * Web server entry point: wires `CodingAgentPiSessionBackend` to the
 * `WebSocket` transport preset and exposes a small programmatic API plus a CLI
 * script.
 *
 * Defaults match the MVP contract from the Web 对话 doc:
 *
 *  - host:       `127.0.0.1`     (never bind to 0.0.0.0)
 *  - port:       `8765`
 *  - path:       `/api/pi/v1/ws`
 *  - cwd:        server process CWD, the only allowed cwd by default
 *  - agentDir:   `~/.pi/agent`
 *  - sessionDir: `<agentDir>/sessions`
 *
 * The exported handle exposes `close()` so callers (CLI, tests) can drive a
 * graceful shutdown that drains live session runtimes before exit.
 */
import { existsSync, mkdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { attachmentStoreReader, CitationService, CitationStore } from "../citations/index.ts";
import type { CodingAgentPiSessionBackendOptions } from "../coding-agent/backend.ts";
import { CodingAgentPiSessionBackend } from "../coding-agent/backend.ts";
import { composeEmbedPlane, type EmbedPlaneHandle } from "../embed/start.ts";
import { PiServerError } from "../errors.ts";
import { type PublishingConfig, parsePublishingConfig } from "../publishing/config.ts";
import { type ControlPlaneHandle, composeControlPlane } from "../publishing/control/compose.ts";
import type { PiServer } from "../server.ts";
import { createWebSocketServer } from "../transports/websocket/preset.ts";
import type { WebSocketServerOptions } from "../transports/websocket/types.ts";
import type { HttpRequestHandler } from "../types.ts";
import { AttachmentStore } from "../uploads/store.ts";
import { VoiceServiceHttpClient } from "../voice/client.ts";
import { LiveSpeechManager } from "../voice/live/live-speech-manager.ts";
import { normalizeVoiceProfiles } from "../voice/profiles.ts";
import { SpeechManager } from "../voice/speech-manager.ts";
import type { VoiceProfile } from "../voice/types.ts";
import { createLiveSpeechHttpHandler } from "./live-speech.ts";
import { createSpeechHttpHandler } from "./speech.ts";
import { createUploadHttpHandler } from "./uploads.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const DEFAULT_PATH = "/api/pi/v1/ws";
const DEFAULT_AGENT_DIR_NAME = ".pi/agent";
const AUTH_PROTOCOL_PREFIX = "pi-auth.";
const WEB_TOKEN_REGEX = /^[A-Za-z0-9._~-]+$/;

/** Speech proxy configuration for the web server. */
export interface WebVoiceOptions {
	/** Voice Service base URL, e.g. `http://127.0.0.1:18876`. */
	baseUrl: string;
	/** Server-to-service bearer secret; never exposed to the browser. */
	token: string;
	/** Profile id used when clients omit `voiceProfileId`. */
	defaultProfile: string;
	/** Voice profile definitions; defaults to the built-in default profile. */
	profiles?: readonly VoiceProfile[];
	/** Max wait for the first PCM chunk. Default 60s. */
	firstChunkTimeoutMs?: number;
	/** Max idle time between chunks. Default 30s. */
	idleTimeoutMs?: number;
	/** Max wall-clock time for one stream. Default 5m. */
	totalTimeoutMs?: number;
	/** Max bytes forwarded per stream. Default 100 MiB. */
	maxBytes?: number;
}

/** Options accepted by `startWebServer`. */
export interface StartWebServerOptions {
	/** Working directory the backend serves. Defaults to `process.cwd()`. */
	cwd?: string;
	/** Override the agent config dir. Defaults to `~/.pi/agent`. */
	agentDir?: string;
	/** Override the persisted session directory. Defaults to `<agentDir>/sessions`. */
	sessionDir?: string;
	/** Override additional allowed cwds. Defaults to `[cwd]`. Use `["*"]` to allow any. */
	allowedCwds?: readonly string[];
	/** Bind address. Defaults to `127.0.0.1`; never accept `0.0.0.0`. */
	host?: string;
	/** TCP port. Defaults to `8765`. */
	port?: number;
	/** WebSocket upgrade path. Defaults to `/api/pi/v1/ws`. */
	path?: string;
	/** Forwarded to the WebSocket listener; useful for the browser dev origin. */
	allowedOrigins?: readonly string[];
	/** Forwarded to the WebSocket listener; useful for proxy hosts. */
	allowedHosts?: readonly string[];
	/** Additional synchronous authorization check performed before upgrade. */
	authorizeUpgrade?: (request: IncomingMessage) => boolean;
	/** Local WebSocket token expected in the `pi-auth.<token>` subprotocol. */
	webToken?: string;
	/** Override the protocol frame length limit. */
	maxFrameLength?: number;
	/** Override the per-connection pending byte budget. */
	maxPendingBytes?: number;
	/** Hook for non-fatal listener/runtime errors. */
	onError?: (error: Error) => void;
	/** Sink for startup / shutdown log lines. Defaults to `console.log`. */
	log?: (message: string) => void;
	/** When true, the returned handle has already been started. */
	autoStart?: boolean;
	/** Speech proxy; when omitted, speech commands and PCM routes are unavailable. */
	voice?: WebVoiceOptions;
	/**
	 * Publishing configuration. When absent or disabled, no publishing
	 * infrastructure (database, Redis, object store, keys) is created and the
	 * existing `/api/pi/v1/ws` path behaves exactly as before.
	 */
	publishing?: PublishingConfig;
}

export interface WebServerHandle {
	readonly server: PiServer;
	readonly backend: CodingAgentPiSessionBackend;
	readonly url: string;
	close(): Promise<void>;
}

/** Validate and normalise options, then build + start the server. */
export async function startWebServer(options: StartWebServerOptions = {}): Promise<WebServerHandle> {
	const resolved = resolveOptions(options);
	const log = options.log ?? console.log.bind(console);
	const publishing = options.publishing ?? parsePublishingConfig(process.env);
	if (publishing.enabled) {
		log("publishing enabled: control/data/runtime planes will be composed by embed/start.ts");
	}

	const backend = await CodingAgentPiSessionBackend.create(resolved.backend);
	// Published conversations must never share the admin/debug session index.
	// Sharing the directory makes embed runtimes appear in the main Chat sidebar
	// and can cause the admin client to attach to a locked public conversation.
	const embedBackend = publishing.enabled
		? await CodingAgentPiSessionBackend.create({
				...resolved.backend,
				sessionDir: join(resolved.sessionDir, "embed"),
				services: backend.getServices(),
			})
		: undefined;

	// 附件与引用索引是进程级共享资源：内部会话流与 embed 引用流共用同一
	// CitationService 实例（TASK-032 完成条件），因此必须先于控制面/数据面
	// 组合创建。
	const attachments = new AttachmentStore(join(resolved.agentDir, "uploads"));
	await attachments.init();
	await attachments.sweepExpired();
	const citations = new CitationService({
		store: new CitationStore(join(resolved.agentDir, "citations")),
		readContent: attachmentStoreReader(attachments),
	});
	await citations.store.init();

	let controlPlane: ControlPlaneHandle | undefined;
	let embedPlane: EmbedPlaneHandle | undefined;
	if (publishing.enabled) {
		// 33.1/33.2: missing token / db / bootstrap config fails startup.
		controlPlane = await composeControlPlane({
			services: backend.getServices(),
			publishing,
			log,
		});
		log("control plane HTTP handler mounted");
		// 24.2: missing pepper / access-token keys fails startup; the embed
		// data plane reuses the control plane's Postgres connection/repos while
		// its Agent sessions remain isolated from the admin/debug session index.
		embedPlane = await composeEmbedPlane({
			publishing,
			repositories: controlPlane.repositories,
			createSession: (options) =>
				(embedBackend ?? backend).createSession({
					id: options.id,
					model: options.model,
					thinkingLevel: options.thinkingLevel,
					streamOptions: options.streamOptions,
				}),
			citations,
			previewTickets: controlPlane.previewTicketService,
			log,
		});
	}

	const httpHandlers: HttpRequestHandler[] = [
		createUploadHttpHandler({
			store: attachments,
			webToken: options.webToken,
			allowedOrigins: resolved.listener.allowedOrigins,
			allowedHosts: resolved.listener.allowedHosts,
		}),
	];

	const {
		speech,
		liveSpeech,
		handlers: voiceHandlers,
	} = buildVoiceLayer(options.voice, {
		webToken: options.webToken,
		allowedOrigins: resolved.listener.allowedOrigins,
		allowedHosts: resolved.listener.allowedHosts,
	});
	httpHandlers.push(...voiceHandlers);
	if (controlPlane !== undefined) httpHandlers.push(controlPlane.handler);
	if (embedPlane !== undefined) {
		httpHandlers.push(
			embedPlane.bootstrapHandler,
			embedPlane.exchangeHandler,
			embedPlane.attachmentsHandler,
			embedPlane.conversationsHandler,
		);
	}
	const httpHandler = composeHttpHandlers(httpHandlers);

	const server = createWebSocketServer(backend, {
		...resolved.listener,
		// TASK-025：embed Realtime upgrade（ticket 校验）接管非主路径 upgrade。
		...(embedPlane?.realtimeUpgrade !== undefined ? { onUnhandledUpgrade: embedPlane.realtimeUpgrade } : {}),
		httpHandler,
		attachments,
		citations,
		speech,
		liveSpeech,
	});

	const autoStart = options.autoStart ?? true;
	if (autoStart) {
		try {
			await server.start();
		} catch (error) {
			log(`server failed to start: ${formatError(error)}`);
			throw error;
		}
	}

	const port = resolved.port;
	const url = `ws://${resolved.host}:${port}${resolved.path}`;
	log(`pi web server listening on ${url}`);
	log(`agent dir: ${resolved.agentDir}`);
	log(`session dir: ${resolved.sessionDir}`);
	if (embedBackend !== undefined) log(`embed session dir: ${join(resolved.sessionDir, "embed")}`);
	log(`allowed cwds: ${resolved.allowedCwds.join(", ")}`);
	if (speech) log(`voice proxy enabled (default profile: ${options.voice?.defaultProfile})`);

	let closing: Promise<void> | undefined;
	const close = async (): Promise<void> => {
		if (closing) return closing;
		closing = (async () => {
			log("pi web server shutting down");
			try {
				await server.close();
			} catch (error) {
				log(`error during server.close: ${formatError(error)}`);
			}
			if (controlPlane !== undefined) {
				try {
					await controlPlane.close();
				} catch (error) {
					log(`error during control plane close: ${formatError(error)}`);
				}
			}
			if (embedPlane !== undefined) {
				try {
					await embedPlane.close();
				} catch (error) {
					log(`error during embed plane close: ${formatError(error)}`);
				}
			}
		})();
		return closing;
	};

	return {
		server,
		backend,
		url,
		close,
	};
}

interface ResolvedOptions {
	backend: CodingAgentPiSessionBackendOptions;
	listener: WebSocketServerOptions;
	host: string;
	port: number;
	path: string;
	agentDir: string;
	sessionDir: string;
	allowedCwds: readonly string[];
}

/** @internal Exported for configuration regression tests. */
export function resolveOptions(options: StartWebServerOptions): ResolvedOptions {
	const cwd = options.cwd ? resolveAbsolute(options.cwd) : resolveAbsolute(process.cwd());
	const agentDir = options.agentDir
		? resolveAbsolute(options.agentDir)
		: resolveAbsolute(join(homedir(), DEFAULT_AGENT_DIR_NAME));
	const sessionDir = options.sessionDir
		? resolveAbsolute(options.sessionDir)
		: resolveAbsolute(join(agentDir, "sessions"));
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}

	const host = options.host ?? DEFAULT_HOST;
	if (host === "0.0.0.0" || host === "::") {
		throw new PiServerError(
			"invalid_request",
			`Refusing to bind ${host}: pi web server must listen on a loopback address`,
		);
	}

	const port = options.port ?? DEFAULT_PORT;
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new PiServerError("invalid_request", `Invalid port: ${port}`);
	}

	const path = options.path ?? DEFAULT_PATH;
	if (!path.startsWith("/")) {
		throw new PiServerError("invalid_request", `WebSocket path must start with /: ${path}`);
	}

	const allowedCwds = (options.allowedCwds ?? [cwd]).map((entry) => (entry === "*" ? entry : resolveAbsolute(entry)));
	const allowedOrigins = options.allowedOrigins ?? ["http://127.0.0.1:*", "http://localhost:*"];
	if (options.webToken !== undefined && !WEB_TOKEN_REGEX.test(options.webToken)) {
		throw new PiServerError(
			"invalid_request",
			"Web token must contain only alphanumeric characters, dot, underscore, tilde, or hyphen",
		);
	}
	const authorizeUpgrade = createUpgradeAuthorization(options.webToken, options.authorizeUpgrade);

	return {
		backend: {
			cwd,
			agentDir,
			sessionDir,
			allowedCwds,
		},
		listener: {
			host,
			port,
			path,
			allowedOrigins,
			allowedHosts: options.allowedHosts,
			authorizeUpgrade,
			maxFrameLength: options.maxFrameLength,
			maxPendingBytes: options.maxPendingBytes,
			onError: options.onError,
		},
		host,
		port,
		path,
		agentDir,
		sessionDir,
		allowedCwds,
	};
}

function createUpgradeAuthorization(
	webToken: string | undefined,
	additionalAuthorization: ((request: IncomingMessage) => boolean) | undefined,
): ((request: IncomingMessage) => boolean) | undefined {
	if (webToken === undefined) return additionalAuthorization;
	return (request) => {
		const protocols = request.headers["sec-websocket-protocol"]?.split(",").map((protocol) => protocol.trim());
		if (!protocols?.includes(`${AUTH_PROTOCOL_PREFIX}${webToken}`)) return false;
		return additionalAuthorization?.(request) ?? true;
	};
}

/** Run each handler until one claims the request; unknown routes fall through to the listener. */
function composeHttpHandlers(handlers: readonly HttpRequestHandler[]): HttpRequestHandler {
	return async (request, response) => {
		for (const handler of handlers) {
			if (await handler(request, response)) return true;
		}
		return false;
	};
}

/**
 * Build the speech + live speech layers from web options. Returns an empty
 * handler list when voice is not configured so no voice store/timer/fetch is
 * ever created. When voice is configured, both the Phase 1 SpeechManager and
 * the Phase 2 LiveSpeechManager are built, `voice.live` is advertised as true,
 * and the two are made mutually exclusive per connection.
 * @internal Exported for configuration tests.
 */
export function buildVoiceLayer(
	voice: WebVoiceOptions | undefined,
	http: { webToken?: string; allowedOrigins?: readonly string[]; allowedHosts?: readonly string[] },
): {
	speech: SpeechManager | undefined;
	liveSpeech: LiveSpeechManager | undefined;
	handlers: HttpRequestHandler[];
} {
	if (!voice) return { speech: undefined, liveSpeech: undefined, handlers: [] };
	const profiles = normalizeVoiceProfiles(voice.profiles);
	if (!profiles.some((profile) => profile.id === voice.defaultProfile)) {
		throw new PiServerError(
			"invalid_request",
			`Voice default profile "${voice.defaultProfile}" is not among the configured profiles`,
		);
	}
	const voiceClient = new VoiceServiceHttpClient({
		baseUrl: voice.baseUrl,
		token: voice.token,
		firstChunkTimeoutMs: voice.firstChunkTimeoutMs,
		idleTimeoutMs: voice.idleTimeoutMs,
		totalTimeoutMs: voice.totalTimeoutMs,
		maxBytes: voice.maxBytes,
	});
	// Mutual exclusion is wired lazily: the checks are closures evaluated at
	// request time, after both managers have been constructed.
	let speech: SpeechManager;
	let liveSpeech: LiveSpeechManager;
	speech = new SpeechManager({
		voiceClient,
		profiles,
		defaultProfileId: voice.defaultProfile,
		live: true,
		liveBusyCheck: (connection) => liveSpeech.hasActiveLiveJob(connection),
	});
	liveSpeech = new LiveSpeechManager({
		voiceClient,
		profiles,
		defaultProfileId: voice.defaultProfile,
		speechBusyCheck: (connection) => speech.hasActiveJob(connection),
	});
	const handlers: HttpRequestHandler[] = [
		createSpeechHttpHandler({
			getSpeechManager: () => speech,
			webToken: http.webToken,
			allowedOrigins: http.allowedOrigins,
			allowedHosts: http.allowedHosts,
		}),
		createLiveSpeechHttpHandler({
			getLiveSpeechManager: () => liveSpeech,
			webToken: http.webToken,
			allowedOrigins: http.allowedOrigins,
			allowedHosts: http.allowedHosts,
		}),
	];
	return { speech, liveSpeech, handlers };
}

function resolveAbsolute(path: string): string {
	return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
