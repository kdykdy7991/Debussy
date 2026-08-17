#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sourceConfig = process.env.PI_MODEL_CONFIG ?? "/home/hello/.pi/agent/models.json";
const provider = process.env.PI_MODEL_PROVIDER ?? "oneapi";
const model = process.env.PI_MODEL_ID ?? "Qwen";
const root = await mkdtemp(join(tmpdir(), "pi-model-fault-"));
const original = JSON.parse(await readFile(sourceConfig, "utf8"));
const providerConfig = original.providers?.[provider];
if (!providerConfig?.baseUrl || !providerConfig?.apiKey) throw new Error(`Provider ${provider} is not configured`);
const upstream = providerConfig.baseUrl;
let mode = "normal";

const server = createServer(async (request, response) => {
	if (mode === "404" || mode === "429") {
		const status = Number(mode);
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { message: `injected ${status}`, type: "injected_error" } }));
		return;
	}
	if (mode === "timeout") {
		setTimeout(() => request.socket.destroy(), 5_000);
		return;
	}
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	const target = new URL(request.url ?? "/", upstream.endsWith("/") ? upstream : `${upstream}/`);
	const headers = { ...request.headers };
	delete headers.host;
	const forwarded = await fetch(target, {
		method: request.method,
		headers,
		body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
	});
	response.writeHead(forwarded.status, Object.fromEntries(forwarded.headers));
	response.end(Buffer.from(await forwarded.arrayBuffer()));
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const port = server.address().port;
original.providers[provider].baseUrl = `http://127.0.0.1:${port}/v1`;
await writeFile(join(root, "models.json"), `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
await writeFile(join(root, "auth.json"), "{}\n", { mode: 0o600 });

async function invoke(nextMode, expectSuccess) {
	mode = nextMode;
	const started = performance.now();
	const result = await new Promise((resolveRun) => {
		const child = spawn(
			resolve("node_modules/.bin/tsx"),
			["--tsconfig", "tsconfig.json", "packages/coding-agent/src/cli.ts", "--offline", "--provider", provider, "--model", model, "-p", "Reply with exactly: ok"],
			{
				cwd: process.cwd(),
				env: { ...process.env, PI_CODING_AGENT_DIR: root },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolveRun({ code, signal, stdout, stderr });
		});
	});
	const succeeded = result.code === 0 && /\bok\b/u.test(result.stdout);
	if (succeeded !== expectSuccess) {
		throw new Error(`${nextMode} expectation failed: code=${result.code} signal=${result.signal} stdout=${result.stdout.slice(0, 300)} stderr=${result.stderr.slice(0, 300)}`);
	}
	console.log(`[model-fault] mode=${nextMode} expected=${expectSuccess ? "success" : "failure"} elapsedMs=${(performance.now() - started).toFixed(1)}`);
}

try {
	await invoke("normal", true);
	await invoke("404", false);
	await invoke("429", false);
	await invoke("timeout", false);
	await invoke("normal", true);
	console.log("Model failure and recovery verification passed.");
} finally {
	await new Promise((resolveClose) => server.close(resolveClose));
	await rm(root, { recursive: true, force: true });
}
