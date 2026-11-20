import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { inspectSandbox, openSandbox, type SandboxExecution, type SandboxExecutionResult } from "../../src/runtime/sandbox.ts";

const runtimeDir = process.env.PI_SANDBOX_TEST_RUNTIME;
const directories: string[] = [];
const executions: SandboxExecution[] = [];

afterEach(async () => {
	for (const execution of executions.splice(0)) await execution.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureRoot(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-sandbox-test-"));
	directories.push(directory);
	return directory;
}

async function sandbox(
	directory: string,
	workspaceId: string,
	signal = new AbortController().signal,
	budgetMs = 10_000,
) {
	if (!runtimeDir) throw new Error("PI_SANDBOX_TEST_RUNTIME is required");
	const execution = await openSandbox(
		{ runtimeDir, workspaceDir: join(directory, "tasks") },
		{ tenantId: "tenant", workspaceId, deadlineAt: Date.now() + budgetMs },
		signal,
	);
	executions.push(execution);
	return execution;
}

async function bash(execution: SandboxExecution, command: string, timeout?: number) {
	const result = await execution.tool.execute("bash-test", { command, timeout }, undefined, undefined, {} as never);
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

test("an unavailable runner rejects local execution", async () => {
	const directory = fixtureRoot();
	writeFileSync(join(directory, "pi-runtime-manifest"), "test fixture");
	await expect(
		openSandbox(
			{ runtimeDir: directory, workspaceDir: join(directory, "workspaces"), runner: join(directory, "missing") },
			{ tenantId: "tenant", workspaceId: "task", deadlineAt: Date.now() + 10_000 },
			new AbortController().signal,
		),
	).rejects.toThrow("SANDBOX_UNAVAILABLE");
});

test.runIf(Boolean(runtimeDir))("a real runner setup failure is distinct from a command failure", async () => {
	const directory = fixtureRoot();
	const invalid = join(directory, "incomplete-runtime");
	mkdirSync(invalid);
	writeFileSync(join(invalid, "pi-runtime-manifest"), "incomplete fixture");
	const results: SandboxExecutionResult[] = [];
	const workspaceDir = join(directory, "tasks");
	const execution = await openSandbox(
		{ runtimeDir: invalid, workspaceDir },
		{ tenantId: "tenant", workspaceId: "test", deadlineAt: Date.now() + 10_000 },
		new AbortController().signal,
		(result) => results.push(result),
	);
	executions.push(execution);
	await expect(bash(execution, "printf not-started")).rejects.toThrow("SANDBOX_START_FAILED");
	expect(execution.failure).toBe("SANDBOX_START_FAILED");
	expect(results).toEqual([
		expect.objectContaining({ status: "start_failed", reason: "SANDBOX_START_FAILED", durationMs: expect.any(Number) }),
	]);
	expect(await inspectSandbox({ runtimeDir: runtimeDir!, workspaceDir })).toMatchObject({ available: true });
	const unavailable = await inspectSandbox({ runtimeDir: invalid, workspaceDir });
	expect(unavailable).toMatchObject({ available: false, error: "SANDBOX_PROBE_FAILED" });
	expect(unavailable).not.toHaveProperty("runtimes");
	const ready = await sandbox(directory, "same-task");
	await expect(bash(ready, "exit 7")).rejects.toThrow("code 7");
	expect(ready.failure).toBeUndefined();
});

test.runIf(Boolean(runtimeDir))(
	"real bwrap isolates files, credentials and network with a shared read-only offline runtime",
	async () => {
		const directory = fixtureRoot();
		const taskA = await sandbox(directory, "task-A");
		const taskB = await sandbox(directory, "task-B");
		const sensitiveFile = join(directory, "host-secret-fixture");
		const outsideFile = join(directory, "outside-write");
		writeFileSync(sensitiveFile, "fixture only");
		const server = createServer();
		await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test listener has no address");
		vi.stubEnv("PI_SANDBOX_TEST_SECRET", "fixture only");
		try {
			const output = await bash(
				taskA,
				[
					"set -e",
					"python3 --version",
					"node --version",
					'python3 -c \'from PIL import __version__; from pathlib import Path; print(__version__); Path("result.txt").write_text("42")\'',
					'node -e \'console.log(require("fs").readFileSync("result.txt", "utf8"))\'',
					`test ! -r '${sensitiveFile}'`,
					`if touch '${outsideFile}' 2>/dev/null; then exit 21; fi`,
					"if touch /usr/bin/sandbox-write 2>/dev/null; then exit 22; fi",
					'test -z "${PI_SANDBOX_TEST_SECRET:-}"',
					`python3 -c 'import socket; socket.create_connection(("127.0.0.1", ${address.port}), .5)' 2>/dev/null && exit 23`,
					"printf isolated",
				].join("\n"),
			);
			expect(output).toContain("Python 3.12.3");
			expect(output).toContain("v22.23.2");
			expect(output).toContain("10.2.0");
			expect(output).toContain("42");
			expect(output).toContain("isolated");
			expect(await bash(taskA, "printf 'a\\0b'")).toBe("a?b");
			expect(existsSync(outsideFile)).toBe(false);
			await taskA.close();
			expect(await bash(await sandbox(directory, "task-A"), "cat result.txt")).toBe("42");
			expect(await bash(taskB, "test ! -e result.txt && printf private")).toBe("private");
		} finally {
			vi.unstubAllEnvs();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	},
);

test.runIf(Boolean(runtimeDir))(
	"real bwrap reaps background processes on completion, timeout and cancellation",
	async () => {
		const directory = fixtureRoot();
		const controller = new AbortController();
		const execution = await sandbox(directory, "child-test", controller.signal);
		await bash(execution, "(sleep 1; touch completed-child-survived) &");
		await expect(bash(execution, "(sleep 1; touch timed-child-survived) & wait", 0.25)).rejects.toThrow("timed out");
		const deadline = await sandbox(directory, "child-test", undefined, 300);
		await expect(bash(deadline, "(sleep 1; touch deadline-child-survived) & wait", 30)).rejects.toThrow("timed out");
		let ready = false;
		const pending = execution.tool.execute(
			"cancel",
			{
				command: "(sleep 1; touch canceled-child-survived) & printf 'started\\n'; wait",
			},
			undefined,
			(update) => {
				ready ||= update.content.some((part) => part.type === "text" && part.text.includes("started"));
			},
			{} as never,
		);
		const rejected = expect(pending).rejects.toThrow("aborted");
		await vi.waitFor(() => expect(ready).toBe(true));
		controller.abort();
		await rejected;
		await execution.close();
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		const inspector = await sandbox(directory, "child-test");
		expect(await bash(inspector, "test -z \"$(find . -name '*-survived' -print)\" && printf reaped")).toBe("reaped");
	},
);
