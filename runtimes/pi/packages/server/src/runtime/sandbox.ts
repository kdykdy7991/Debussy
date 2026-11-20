import { type ChildProcessByStdio, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { arch, type as osType, release } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import {
	type BashOperations,
	createBashToolDefinition,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
	AdminSandboxEnvironment,
	SandboxExecutionStatus,
	SandboxPythonPackage,
	SandboxRuntimeInfo,
} from "@earendil-works/pi-protocol";

export interface SandboxConfig {
	readonly runtimeDir: string;
	readonly workspaceDir: string;
	readonly runner?: string;
}

export interface SandboxPolicy {
	readonly tenantId: string;
	readonly workspaceId: string;
	readonly deadlineAt: number;
}

export type SandboxFailure = "SANDBOX_UNAVAILABLE" | "SANDBOX_START_FAILED";
export interface SandboxExecutionResult {
	readonly status: SandboxExecutionStatus;
	readonly startedAt: string;
	readonly endedAt: string;
	readonly durationMs: number;
	readonly reason: string | null;
}

export const SANDBOX_PROVIDER = "linux-bwrap";
const defaultRunner = "/usr/bin/bwrap";
const readiness = "PI_SANDBOX_READY";
const maxOutputBytes = 32 * 1024;
// Keep output below Pi's line truncation threshold too, so it never spills to host temp.
const maxOutputLines = 1_000;

export class SandboxError extends Error {
	readonly code: SandboxFailure;
	constructor(code: SandboxFailure) {
		super(code);
		this.code = code;
	}
}

export function sandboxConfigFromEnv(env: NodeJS.ProcessEnv): SandboxConfig | undefined {
	const runtimeDir = env.PI_SANDBOX_RUNTIME_DIR;
	const workspaceDir = env.PI_SANDBOX_WORKSPACE_DIR;
	if (!runtimeDir || !workspaceDir) return undefined;
	return { runtimeDir, workspaceDir };
}

function contains(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function prepareRoots(config: SandboxConfig) {
	if (process.platform !== "linux" || !isAbsolute(config.runtimeDir) || !isAbsolute(config.workspaceDir)) {
		throw new SandboxError("SANDBOX_UNAVAILABLE");
	}
	try {
		const runtime = await realpath(config.runtimeDir);
		const manifest = await lstat(join(runtime, "pi-runtime-manifest"));
		if (runtime === "/" || !manifest.isFile()) throw new Error("Invalid Sandbox runtime root");
		await mkdir(config.workspaceDir, { recursive: true, mode: 0o700 });
		const root = await realpath(config.workspaceDir);
		if (contains(runtime, root) || contains(root, runtime)) throw new Error("Sandbox roots overlap");
		await assertPrivateDirectory(root);
		return { runtime, root };
	} catch {
		throw new SandboxError("SANDBOX_UNAVAILABLE");
	}
}

async function assertPrivateDirectory(directory: string) {
	const stat = await lstat(directory);
	if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
		throw new SandboxError("SANDBOX_UNAVAILABLE");
	}
}

export async function inspectSandbox(config: SandboxConfig | undefined): Promise<AdminSandboxEnvironment> {
	const runner = config?.runner ?? defaultRunner;
	const osRelease = await readFile("/etc/os-release", "utf8").catch(() => "");
	const distribution = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(osRelease)?.[1];
	const kernel = `${osType()} ${release()} (${arch()})`;
	const base = { provider: "Bubblewrap" as const, os: distribution ? `${distribution} · ${kernel}` : kernel };
	let bwrapVersion: string | null = null;
	try {
		if (!isAbsolute(runner)) throw new SandboxError("SANDBOX_UNAVAILABLE");
		const version = await promisify(execFile)(runner, ["--version"], {
			timeout: 2_000,
			maxBuffer: 1024,
			env: {},
		}).catch(() => undefined);
		bwrapVersion = /^bubblewrap (\S+)$/.exec(version?.stdout.trim() ?? "")?.[1] ?? null;
		if (!config || !bwrapVersion) throw new SandboxError("SANDBOX_UNAVAILABLE");
		const { runtime, root } = await prepareRoots(config);
		const workspace = await mkdtemp(join(root, ".sandbox-probe-"));
		try {
			const chunks: Buffer[] = [];
			const result = await runCommand(
				runner,
				runtime,
				workspace,
				probeCommand,
				Date.now() + 5_000,
				{
					signal: new AbortController().signal,
					onData: (chunk) => chunks.push(chunk),
				},
				() => undefined,
				undefined,
				{ bytes: 1024 * 1024, lines: Infinity },
			);
			if (result.exitCode !== 0) throw new Error("Runtime probe failed");
			const inventory = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
				runtimes: SandboxRuntimeInfo[];
				pythonPackages: SandboxPythonPackage[];
			};
			return {
				...base,
				bwrapVersion,
				available: true,
				runtimeDir: runtime,
				workspaceDir: root,
				runtimeReadOnly: true,
				workspaceMount: "/workspace",
				workspaceScope: "task",
				network: "isolated",
				executionPolicy: "per_bash_call",
				dependencyMode: "offline_preinstalled",
				runtimes: inventory.runtimes,
				pythonPackages: inventory.pythonPackages,
			};
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	} catch (error) {
		return {
			...base,
			bwrapVersion,
			available: false,
			error:
				error instanceof SandboxError && error.code === "SANDBOX_UNAVAILABLE"
					? "SANDBOX_UNAVAILABLE"
					: "SANDBOX_PROBE_FAILED",
		};
	}
}

// Run in an empty workspace and skip Python's user site and implicit import path.
const probeCommand = `/usr/bin/python3 -s -P -c '
import importlib.metadata
import json
import platform
import subprocess
import sys

node = json.loads(subprocess.check_output(
    ["/usr/bin/node", "-p", "JSON.stringify({version:process.version, path:process.execPath})"]
))
packages = []
for dist in importlib.metadata.distributions():
    metadata = dist.metadata
    name, version = metadata["Name"], metadata["Version"]
    if not name or not version:
        raise ValueError("Invalid Python distribution metadata")
    packages.append(dict(name=name, version=version, location=str(dist.locate_file(""))))
print(json.dumps(dict(
    runtimes=[
        dict(name="Bash", version=sys.argv[1], path=sys.argv[2]),
        dict(name="Python", version=platform.python_version(), path=sys.executable),
        dict(name="Node.js", **node),
    ],
    pythonPackages=sorted(packages, key=lambda package: package["name"].casefold()),
)))
' "$BASH_VERSION" "$BASH"`;

export interface SandboxExecution {
	readonly tool: ToolDefinition;
	readonly failure: SandboxFailure | undefined;
	close(): Promise<void>;
}

export async function openSandbox(
	config: SandboxConfig | undefined,
	policy: SandboxPolicy,
	signal: AbortSignal,
	onResult?: (result: SandboxExecutionResult) => void,
): Promise<SandboxExecution> {
	if (!config) throw new SandboxError("SANDBOX_UNAVAILABLE");
	signal.throwIfAborted();
	const runner = config.runner ?? defaultRunner;
	if (!isAbsolute(runner)) throw new SandboxError("SANDBOX_UNAVAILABLE");
	await access(runner, constants.X_OK).catch(() => {
		throw new SandboxError("SANDBOX_UNAVAILABLE");
	});
	const { runtime, root } = await prepareRoots(config);
	const key = createHash("sha256")
		.update(JSON.stringify([policy.tenantId, policy.workspaceId]))
		.digest("hex");
	const workspace = join(root, key);
	try {
		await mkdir(workspace, { mode: 0o700, recursive: true });
		await assertPrivateDirectory(workspace);
	} catch {
		throw new SandboxError("SANDBOX_UNAVAILABLE");
	}
	const owner = new AbortController();
	const active = new Set<Promise<unknown>>();
	let failure: SandboxFailure | undefined;
	let unconfirmed = false;
	const operations: BashOperations = {
		exec(command, _cwd, options) {
			const signals = [signal, owner.signal];
			if (options.signal) signals.push(options.signal);
			const commandSignal = AbortSignal.any(signals);
			const execution = runCommand(
				runner,
				runtime,
				workspace,
				command,
				policy.deadlineAt,
				{ ...options, signal: commandSignal },
				() => {
					unconfirmed = true;
				},
				onResult,
			).catch((error: unknown) => {
				if (error instanceof SandboxError) failure ??= error.code;
				throw error;
			});
			active.add(execution);
			const remove = () => active.delete(execution);
			void execution.then(remove, remove);
			return execution;
		},
	};
	const definition = createBashToolDefinition("/workspace", {
		operations,
		exposeSessionEnvironment: false,
	});
	return {
		tool: defineTool({
			...definition,
			executionMode: "sequential",
			description:
				"Run Bash in the isolated Task workspace (/workspace). Python 3, Node.js and Pillow are preinstalled. Network and package installation are unavailable. Files under /workspace are available to later Operations of this Task.",
		}),
		get failure() {
			return failure;
		},
		async close() {
			owner.abort();
			await Promise.allSettled(active);
			if (unconfirmed) throw new Error("Sandbox child exit could not be confirmed");
		},
	};
}

type CommandOptions = Parameters<BashOperations["exec"]>[2] & { signal: AbortSignal };

async function runCommand(
	runner: string,
	runtime: string,
	workspace: string,
	command: string,
	deadlineAt: number,
	{ signal, timeout, onData }: CommandOptions,
	onUnconfirmed: () => void,
	onResult?: (result: SandboxExecutionResult) => void,
	limits = { bytes: maxOutputBytes, lines: maxOutputLines },
): Promise<{ exitCode: number | null }> {
	if (signal.aborted) throw new Error("aborted");
	if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
		throw new Error("Invalid timeout: must be a finite positive number of seconds");
	}
	const remaining = deadlineAt - Date.now();
	const budget = Math.min(remaining, timeout === undefined ? remaining : timeout * 1_000);
	if (!Number.isFinite(budget) || budget <= 0) throw new Error(`timeout:${Math.max(0, budget) / 1_000}`);
	// The trusted wrapper announces readiness before passing the command as an argument.
	// PID 1 exits with the command and the kernel then reaps its PID namespace.
	const args = [
		"--unshare-all",
		"--unshare-user",
		"--disable-userns",
		"--assert-userns-disabled",
		"--die-with-parent",
		"--new-session",
		"--as-pid-1",
		"--cap-drop",
		"ALL",
		"--clearenv",
		"--ro-bind",
		runtime,
		"/",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		"--bind",
		workspace,
		"/workspace",
		"--chdir",
		"/workspace",
		"--setenv",
		"PATH",
		"/usr/bin",
		"--setenv",
		"HOME",
		"/workspace",
		"--setenv",
		"TMPDIR",
		"/tmp",
		"--setenv",
		"LANG",
		"C.UTF-8",
		"--setenv",
		"PYTHONPATH",
		"/usr/lib/python3/dist-packages",
		"--",
		"/usr/bin/bash",
		"--noprofile",
		"--norc",
		"-c",
		`printf '%s\\n' '${readiness}'; exec /usr/bin/bash --noprofile --norc -c "$1"`,
		"pi-sandbox",
		command,
	];
	const startedAt = new Date().toISOString();
	const started = performance.now();
	const report = (status: SandboxExecutionStatus, reason: string | null) => {
		onResult?.({
			status,
			reason,
			startedAt,
			endedAt: new Date().toISOString(),
			durationMs: Math.round(performance.now() - started),
		});
	};
	return new Promise((resolve, reject) => {
		let child: ChildProcessByStdio<null, Readable, Readable>;
		try {
			child = spawn(runner, args, { cwd: "/", env: {}, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			// System errors can be synchronous, while argument validation occurs before launch.
			if (error instanceof Error && "errno" in error) report("start_failed", "SANDBOX_START_FAILED");
			reject(error);
			return;
		}
		let ready = false;
		let prefix = "";
		let startupStderr = Buffer.alloc(0);
		let bytes = 0;
		let lines = 0;
		let truncated = false;
		let stopCause: "timeout" | "canceled" | undefined;
		let settled = false;
		let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (status: SandboxExecutionStatus, reason: string | null, error?: Error, exitCode?: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (cleanupTimer) clearTimeout(cleanupTimer);
			signal.removeEventListener("abort", abort);
			report(status, reason);
			if (truncated) onData(Buffer.from("\n[Sandbox output limit reached]\n"));
			if (error) reject(error);
			else resolve({ exitCode: exitCode ?? null });
		};
		const terminate = () => {
			if (settled || cleanupTimer) return;
			child.kill("SIGKILL");
			cleanupTimer = setTimeout(() => {
				onUnconfirmed();
				child.stdout.destroy();
				child.stderr.destroy();
				child.unref();
				finish(stopCause ?? "canceled", "SANDBOX_CLEANUP_UNCONFIRMED", new Error("SANDBOX_CLEANUP_UNCONFIRMED"));
			}, 3_000);
		};
		const abort = () => {
			stopCause ??= Date.now() >= deadlineAt ? "timeout" : "canceled";
			terminate();
		};
		const timer = setTimeout(() => {
			stopCause ??= "timeout";
			terminate();
		}, budget);
		const forward = (chunk: Buffer) => {
			if (!ready || truncated) return;
			const available = chunk.subarray(0, limits.bytes - bytes);
			let end = available.length;
			for (let index = available.indexOf(10); index !== -1; index = available.indexOf(10, index + 1)) {
				if (++lines === limits.lines) {
					end = index + 1;
					break;
				}
			}
			bytes += end;
			truncated = end < chunk.length || bytes >= limits.bytes || lines >= limits.lines;
			const output = available.subarray(0, end);
			// PostgreSQL JSONB cannot represent NUL, even when JSON escapes it.
			for (let index = output.indexOf(0); index !== -1; index = output.indexOf(0, index + 1)) output[index] = 63;
			onData(output);
		};
		child.stdout.on("data", (chunk: Buffer) => {
			if (ready) {
				forward(chunk);
				return;
			}
			const newline = chunk.indexOf(10);
			if (newline === -1) {
				prefix = (prefix + chunk.toString()).slice(0, readiness.length + 1);
				return;
			}
			ready = prefix + chunk.subarray(0, newline).toString() === readiness;
			if (ready) {
				forward(startupStderr);
				startupStderr = Buffer.alloc(0);
				forward(chunk.subarray(newline + 1));
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (ready) forward(chunk);
			else if (startupStderr.length < maxOutputBytes) {
				startupStderr = Buffer.concat([startupStderr, chunk.subarray(0, maxOutputBytes - startupStderr.length)]);
			}
		});
		child.once("error", () => {
			// A spawn failure has no child to clean up. Errors after spawn (e.g.
			// kill failure) must still wait for close or report unconfirmed cleanup.
			if (child.pid === undefined)
				finish("start_failed", "SANDBOX_UNAVAILABLE", new SandboxError("SANDBOX_UNAVAILABLE"));
		});
		child.once("close", (code) => {
			if (stopCause === "canceled") finish("canceled", "EXECUTION_ABORTED", new Error("aborted"));
			else if (stopCause === "timeout")
				finish("timeout", "EXECUTION_TIMEOUT", new Error(`timeout:${budget / 1_000}`));
			else if (!ready) finish("start_failed", "SANDBOX_START_FAILED", new SandboxError("SANDBOX_START_FAILED"));
			else if (code === 0) finish("success", null, undefined, 0);
			else finish("command_failed", code === null ? "COMMAND_TERMINATED" : `EXIT_${code}`, undefined, code ?? 1);
		});
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}
