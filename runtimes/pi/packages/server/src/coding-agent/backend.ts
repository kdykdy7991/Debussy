/**
 * Backend adapter: implements `PiSessionBackend` by translating between the
 * server's wire-level session boundary and the Coding Agent's `AgentSession`
 * lifecycle.
 *
 * The backend owns:
 *
 *  - A persistent `SessionManager` per cwd root, so `createSession()` and
 *    `openSession()` use the same JSONL store the rest of the coding-agent
 *    already writes to.
 *  - A live-runtimes registry keyed by session id so concurrent
 *    `attach` / `prompt` / etc. requests resolve to the same `AgentSession`
 *    and write operations against the same session reject with
 *    `session_locked` / `busy` rather than silently queueing.
 *
 * The server assigns session IDs at creation time; the backend persists those
 * exact IDs into the session header so reopen survives the restart.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
	type AgentSession,
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelMetadata, ModelRef, SessionSummary, ThinkingLevel } from "@earendil-works/pi-protocol";
import { PiServerError } from "../errors.ts";
import type { CreateSessionOptions, PiSessionBackend, PiSessionRuntime } from "../types.ts";
import { CodingAgentPiSessionRuntime } from "./runtime.ts";

const ALL_CWD_MARKER = "*";
const SESSION_ID_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export interface CodingAgentPiSessionBackendOptions {
	cwd: string;
	agentDir: string;
	sessionDir?: string;
	allowedCwds?: readonly string[];
	/** Optional pre-built services (skip startup model/extension loading). */
	services?: AgentSessionServices;
}

interface SessionFileRecord {
	path: string;
	createdAt: number;
	updatedAt: number;
	name?: string;
	cwd: string;
}

/**
 * Persists sessions to disk through a Coding Agent `SessionManager` and tracks
 * live runtimes so concurrent acquire requests resolve to the same AgentSession.
 */
export class CodingAgentPiSessionBackend implements PiSessionBackend {
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly sessionDir: string;
	private readonly allowedCwds: readonly string[];
	private readonly services: AgentSessionServices;
	private readonly liveRuntimes = new Map<string, CodingAgentPiSessionRuntime>();
	private readonly sessionFileById = new Map<string, string>();
	private readonly sessionInfoByPath = new Map<string, SessionFileRecord>();
	private listingPromise?: Promise<SessionFileRecord[]>;

	private constructor(
		cwd: string,
		agentDir: string,
		sessionDir: string,
		allowedCwds: readonly string[],
		services: AgentSessionServices,
	) {
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.sessionDir = sessionDir;
		this.allowedCwds = allowedCwds;
		this.services = services;
	}

	/**
	 * Build the backend. `createAgentSessionServices` is async because it
	 * loads models and extensions; we run it once here and reuse the result.
	 */
	static async create(options: CodingAgentPiSessionBackendOptions): Promise<CodingAgentPiSessionBackend> {
		const cwd = resolveAbsolute(options.cwd);
		const agentDir = resolveAbsolute(options.agentDir);
		const sessionDir = options.sessionDir
			? resolveAbsolute(options.sessionDir)
			: resolveAbsolute(join(agentDir, "sessions"));
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}
		const allowedCwds = options.allowedCwds ?? [cwd];
		const services =
			options.services ??
			(await createAgentSessionServices({
				cwd,
				agentDir,
			}));
		return new CodingAgentPiSessionBackend(cwd, agentDir, sessionDir, allowedCwds, services);
	}

	async listSessions(): Promise<SessionSummary[]> {
		const records = await this.loadSessionIndex();
		const summaries: SessionSummary[] = [];
		for (const record of records) {
			const id = this.idForRecord(record);
			const runtime = this.liveRuntimes.get(id);
			if (runtime) {
				const snapshot = runtime.snapshot();
				summaries.push({ ...snapshot, attached: true, locked: true });
				continue;
			}
			summaries.push(toSummary(id, record, false, false));
		}
		return summaries;
	}

	async listModels(): Promise<ModelMetadata[]> {
		// Only surface models whose provider has working auth. Unconfigured
		// providers still contribute catalog entries, but the server snapshot
		// must not advertise models the client cannot actually use.
		const all = this.services.modelRuntime.getAvailableSnapshot();
		const out: ModelMetadata[] = [];
		for (const model of all) {
			out.push(toModelMetadata(model));
		}
		return out;
	}

	async createSession(options: CreateSessionOptions): Promise<PiSessionRuntime> {
		assertValidSessionId(options.id);
		if (!this.isCwdAllowed(options.cwd)) {
			throw new PiServerError("invalid_request", `cwd not allowed: ${options.cwd ?? "(default)"}`);
		}
		if (this.liveRuntimes.has(options.id)) {
			throw new PiServerError("session_locked", `Session already exists: ${options.id}`);
		}
		const cwd = options.cwd ? resolveAbsolute(options.cwd) : this.cwd;
		const sessionManager = SessionManager.create(cwd, this.sessionDir, { id: options.id });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new PiServerError("invalid_request", `Backend failed to allocate a session file for ${options.id}`);
		}
		const model = options.model ? this.resolveModel(options.model) : undefined;
		const result = await createAgentSessionFromServices({
			services: this.services,
			sessionManager,
			model: model as never,
			thinkingLevel: options.thinkingLevel as ThinkingLevel | undefined,
			sessionStartEvent: {
				type: "session_start",
				reason: "new",
			},
		});
		const wrapper = this.registerLive(options.id, result.session);
		this.sessionFileById.set(options.id, sessionFile);
		return wrapper;
	}

	async openSession(sessionId: string): Promise<PiSessionRuntime> {
		assertValidSessionId(sessionId);
		const live = this.liveRuntimes.get(sessionId);
		if (live) return live;
		const sessionFile = await this.findSessionFile(sessionId);
		if (!sessionFile) {
			throw new PiServerError("not_found", `Unknown session: ${sessionId}`);
		}
		const sessionManager = SessionManager.open(sessionFile, this.sessionDir);
		if (sessionManager.getSessionId() !== sessionId) {
			throw new PiServerError(
				"invalid_request",
				`Session id mismatch: file=${sessionManager.getSessionId()} requested=${sessionId}`,
			);
		}
		const result = await createAgentSessionFromServices({
			services: this.services,
			sessionManager,
			sessionStartEvent: {
				type: "session_start",
				reason: "resume",
			},
		});
		const wrapper = this.registerLive(sessionId, result.session);
		return wrapper;
	}

	/**
	 * Track a live runtime so concurrent acquire requests resolve to the same
	 * AgentSession. The wrapper notifies us when the owning session manager
	 * disposes it, at which point the entry drops from the live registry.
	 */
	private registerLive(id: string, session: AgentSession): CodingAgentPiSessionRuntime {
		const wrapper = new CodingAgentPiSessionRuntime(session, () => {
			if (this.liveRuntimes.get(id) === wrapper) {
				this.liveRuntimes.delete(id);
			}
		});
		this.liveRuntimes.set(id, wrapper);
		return wrapper;
	}

	private async findSessionFile(sessionId: string): Promise<string | undefined> {
		const cached = this.sessionFileById.get(sessionId);
		if (cached && existsSync(cached)) return cached;
		const records = await this.loadSessionIndex();
		for (const record of records) {
			if (this.idForRecord(record) === sessionId) {
				this.sessionFileById.set(sessionId, record.path);
				return record.path;
			}
		}
		return undefined;
	}

	private async loadSessionIndex(): Promise<SessionFileRecord[]> {
		if (this.listingPromise) return this.listingPromise;
		this.listingPromise = this.scanSessionDir();
		try {
			return await this.listingPromise;
		} finally {
			this.listingPromise = undefined;
		}
	}

	private async scanSessionDir(): Promise<SessionFileRecord[]> {
		if (!existsSync(this.sessionDir)) return [];
		const files = readdirSync(this.sessionDir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => join(this.sessionDir, name));
		const records: SessionFileRecord[] = [];
		for (const file of files) {
			const cached = this.sessionInfoByPath.get(file);
			if (cached) {
				records.push(cached);
				continue;
			}
			try {
				const manager = SessionManager.open(file);
				const header = manager.getHeader();
				if (!header) continue;
				const record: SessionFileRecord = {
					path: file,
					createdAt: Date.parse(header.timestamp) || 0,
					updatedAt: fileMtime(file),
					name: manager.getSessionName(),
					cwd: header.cwd,
				};
				this.sessionInfoByPath.set(file, record);
				records.push(record);
			} catch {
				// Skip files that are not parseable sessions.
			}
		}
		records.sort((a, b) => b.updatedAt - a.updatedAt);
		return records;
	}

	private idForRecord(record: SessionFileRecord): string {
		// File names look like `YYYY-MM-DDTHH-MM-SS_<id>.jsonl`.
		const base = record.path.split(/[\\/]/).pop() ?? "";
		const match = base.match(/^.+?_(.+)\.jsonl$/);
		return match ? match[1] : base;
	}

	private isCwdAllowed(cwd: string | undefined): boolean {
		if (this.allowedCwds.includes(ALL_CWD_MARKER)) return true;
		const target = cwd ? resolveAbsolute(cwd) : this.cwd;
		return this.allowedCwds.some((root) => {
			const normalised = resolveAbsolute(root);
			return target === normalised || target.startsWith(`${normalised}/`);
		});
	}

	private resolveModel(model: ModelRef): unknown {
		const found = this.services.modelRuntime.getModel(model.provider, model.id);
		if (!found) {
			throw new PiServerError("not_found", `Model not available: ${model.provider}/${model.id}`);
		}
		return found;
	}
}

function assertValidSessionId(id: string): void {
	if (!SESSION_ID_REGEX.test(id)) {
		throw new PiServerError(
			"invalid_request",
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

function resolveAbsolute(path: string): string {
	// Honour absolute paths and resolve relative paths against process.cwd().
	// Tilde is not expanded; server runs on 127.0.0.1 and expects fully-qualified paths.
	return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function toSummary(id: string, record: SessionFileRecord, locked: boolean, attached: boolean): SessionSummary {
	return {
		id,
		name: record.name,
		cwd: record.cwd,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		phase: "idle",
		model: { provider: "unknown", id: "unknown" },
		thinkingLevel: "off",
		attached,
		locked,
	};
}

function fileMtime(file: string): number {
	try {
		// The protocol timestamp schema is an integer; statSync mtimeMs is a float.
		return Math.floor(statSync(file).mtimeMs);
	} catch {
		return 0;
	}
}

function toModelMetadata(model: {
	id: string;
	name: string;
	api: string;
	provider: string;
	reasoning: boolean;
	input: readonly ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	thinkingLevelMap?: Record<string, unknown>;
}): ModelMetadata {
	const supportedThinkingLevels: ThinkingLevel[] = ["off"];
	if (model.reasoning) {
		supportedThinkingLevels.push("low", "medium", "high");
	}
	if (model.thinkingLevelMap && "minimal" in model.thinkingLevelMap) {
		supportedThinkingLevels.push("minimal");
	}
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		api: model.api,
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: nonNegativeInt(model.contextWindow, 1),
		maxTokens: nonNegativeInt(model.maxTokens, 1),
		// Some catalogs use negative cost as a "varies" sentinel; the protocol
		// schema requires non-negative numbers, so clamp them.
		cost: {
			input: nonNegativeInt(model.cost.input, 0),
			output: nonNegativeInt(model.cost.output, 0),
			cacheRead: nonNegativeInt(model.cost.cacheRead, 0),
			cacheWrite: nonNegativeInt(model.cost.cacheWrite, 0),
		},
		supportedThinkingLevels,
		authenticated: true,
	};
}

function nonNegativeInt(value: number, fallback: number): number {
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}
