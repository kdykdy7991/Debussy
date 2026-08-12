#!/usr/bin/env node
import { normalizeVoiceProfiles } from "../voice/profiles.ts";
/**
 * Dev entry point: starts the Pi web server with sensible defaults and binds
 * SIGINT/SIGTERM to a graceful shutdown that drains live session runtimes.
 *
 * Usage:
 *   pi-web [--host <host>] [--port <port>] [--cwd <path>]
 *          [--agent-dir <path>] [--session-dir <path>]
 *          [--allow-cwd <path>]... [--allow-origin <origin>]...
 *          [--max-frame-length <bytes>] [--max-pending-bytes <bytes>]
 */
import type { VoiceProfile } from "../voice/types.ts";
import { type StartWebServerOptions, startWebServer, type WebVoiceOptions } from "./start.ts";

interface CliFlags {
	host?: string;
	port?: number;
	cwd?: string;
	agentDir?: string;
	sessionDir?: string;
	allowCwds: string[];
	allowOrigins: string[];
	allowHosts: string[];
	maxFrameLength?: number;
	maxPendingBytes?: number;
	help: boolean;
}

function parseArgs(argv: readonly string[]): CliFlags {
	const flags: CliFlags = {
		allowCwds: [],
		allowOrigins: [],
		allowHosts: [],
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			flags.help = true;
		} else if (arg === "--host") {
			flags.host = argv[++i];
		} else if (arg === "--port") {
			flags.port = Number.parseInt(argv[++i] ?? "", 10);
			if (!Number.isFinite(flags.port)) {
				throw new Error(`Invalid --port: ${argv[i]}`);
			}
		} else if (arg === "--cwd") {
			flags.cwd = argv[++i];
		} else if (arg === "--agent-dir") {
			flags.agentDir = argv[++i];
		} else if (arg === "--session-dir") {
			flags.sessionDir = argv[++i];
		} else if (arg === "--allow-cwd") {
			flags.allowCwds.push(argv[++i] ?? "");
		} else if (arg === "--allow-origin") {
			flags.allowOrigins.push(argv[++i] ?? "");
		} else if (arg === "--allow-host") {
			flags.allowHosts.push(argv[++i] ?? "");
		} else if (arg === "--max-frame-length") {
			flags.maxFrameLength = Number.parseInt(argv[++i] ?? "", 10);
		} else if (arg === "--max-pending-bytes") {
			flags.maxPendingBytes = Number.parseInt(argv[++i] ?? "", 10);
		} else {
			throw new Error(`Unknown flag: ${arg}`);
		}
	}
	return flags;
}

/**
 * Voice proxy is configured entirely through environment variables so the
 * server-to-service secret never appears on the command line.
 *
 *   PI_VOICE_URL               base URL of the Voice Service (required to enable speech)
 *   PI_VOICE_TOKEN             server-to-service bearer secret (required when URL is set)
 *   PI_VOICE_DEFAULT_PROFILE   profile id used when the client omits it (default "default")
 *   PI_VOICE_PROFILES          optional JSON array of { id, name, language, speaker, instruct }
 */
function buildVoiceOptionsFromEnv(): WebVoiceOptions | undefined {
	const baseUrl = process.env.PI_VOICE_URL;
	if (!baseUrl) return undefined;
	const token = process.env.PI_VOICE_TOKEN;
	if (!token) throw new Error("PI_VOICE_URL is set but PI_VOICE_TOKEN is missing");
	const defaultProfile = process.env.PI_VOICE_DEFAULT_PROFILE ?? "default";
	const profiles = parseProfilesEnv();
	return { baseUrl, token, defaultProfile, ...(profiles ? { profiles } : {}) };
}

function parseProfilesEnv(): VoiceProfile[] | undefined {
	const raw = process.env.PI_VOICE_PROFILES;
	if (raw === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("PI_VOICE_PROFILES must be valid JSON");
	}
	if (!Array.isArray(parsed)) throw new Error("PI_VOICE_PROFILES must be a JSON array");
	return normalizeVoiceProfiles(parsed as VoiceProfile[]);
}

function printHelp(): void {
	console.log(`pi-web — dev server for the Pi web UI

Usage:
  pi-web [flags]

Flags:
  --host <host>             Bind address (default 127.0.0.1)
  --port <port>             TCP port (default 8765)
  --cwd <path>              Working directory (default process.cwd())
  --agent-dir <path>        Agent config dir (default ~/.pi/agent)
  --session-dir <path>      Override session storage directory
  --allow-cwd <path>        Additional allowed cwd (repeatable)
  --allow-origin <origin>   WebSocket allowed origin (repeatable)
  --allow-host <host>       WebSocket allowed Host (repeatable)
  --max-frame-length <n>    Override max protocol frame length
  --max-pending-bytes <n>   Override per-connection pending byte budget
  --help, -h                Show this help

Signals:
  SIGINT, SIGTERM           Trigger graceful shutdown`);
}

async function main(): Promise<number> {
	let flags: CliFlags;
	try {
		flags = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		printHelp();
		return 2;
	}

	if (flags.help) {
		printHelp();
		return 0;
	}

	const options: StartWebServerOptions = {
		host: flags.host,
		port: flags.port,
		cwd: flags.cwd,
		agentDir: flags.agentDir,
		sessionDir: flags.sessionDir,
		allowedCwds: flags.allowCwds.length > 0 ? flags.allowCwds : undefined,
		allowedOrigins: flags.allowOrigins.length > 0 ? flags.allowOrigins : undefined,
		allowedHosts: flags.allowHosts.length > 0 ? flags.allowHosts : undefined,
		maxFrameLength: flags.maxFrameLength,
		maxPendingBytes: flags.maxPendingBytes,
		webToken: process.env.PI_WEB_TOKEN,
		voice: buildVoiceOptionsFromEnv(),
	};

	const handle = await startWebServer(options);

	let shuttingDown = false;
	const shutdown = async (exitCode: number): Promise<number> => {
		if (shuttingDown) return exitCode;
		shuttingDown = true;
		try {
			await handle.close();
		} catch (error) {
			console.error(`shutdown error: ${error instanceof Error ? error.message : String(error)}`);
			return 1;
		}
		return exitCode;
	};

	process.on("SIGINT", () => {
		void shutdown(0).then(process.exit);
	});
	process.on("SIGTERM", () => {
		void shutdown(0).then(process.exit);
	});
	process.on("uncaughtException", (error) => {
		console.error(error);
		void shutdown(1).then(process.exit);
	});
	process.on("unhandledRejection", (reason) => {
		console.error(reason);
		void shutdown(1).then(process.exit);
	});

	// Park forever; signals trigger shutdown.
	await new Promise<void>(() => {});
	return 0;
}

void main().then(
	(code) => {
		if (code !== 0) process.exit(code);
	},
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
