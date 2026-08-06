/**
 * P0 联调 smoke：无需真实模型凭据，用 faux provider 端到端验证协议 v2 的可靠流式链路。
 *
 * 用法（仓库根目录）：
 *   npm run smoke:p0
 *
 * 服务端是真实的 `PiServer` WebSocket listener + `CodingAgentPiSessionBackend`（faux
 * provider，不碰任何真实模型 API）；客户端是真实的 `@earendil-works/pi-client`（与前端
 * `packages/web` 共用同一套库，自动 resume + 按 sequence 去重）。
 *
 * 覆盖场景：
 *   1. 首连：hello 握手 + 协议版本 = PROTOCOL_VERSION。
 *   2. 流式 delta：prompt 产生 text/thinking 的 assistant_delta 事件。
 *   3. 断线：A 的 WebSocket 被 terminate（模拟网络中断）。
 *   4. 自动 resume：A 重连后 attachSession 自动改发 resume，服务端重放漏掉的
 *      session_progress 事件。
 *   5. 重复事件去重：A 的事件流严格递增、无重复 sequence。
 *   6. 最终快照一致性：A 恢复后的 transcript/lastSequence 与从未掉线的 B 完全一致。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	type AgentSessionServices,
	createExtensionRuntime,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type ByteTransportFactory, PiClient } from "@earendil-works/pi-client";
import { PROTOCOL_VERSION } from "@earendil-works/pi-protocol";
import { CodingAgentPiSessionBackend } from "@earendil-works/pi-server/coding-agent";
import { createWebSocketServer } from "@earendil-works/pi-server/websocket";
import { WebSocket } from "ws";

type PiServer = ReturnType<typeof createWebSocketServer>;
type FauxHandle = ReturnType<typeof fauxProvider>;

const CONNECT_TIMEOUT_MS = 10_000;
const DROP_TIMEOUT_MS = 5_000;

interface ProgressEvent {
	sequence: number;
	type: string;
	kind?: string;
}

function toUint8Array(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
	if (Array.isArray(data)) {
		const length = data.reduce((total, chunk) => total + chunk.byteLength, 0);
		const merged = new Uint8Array(length);
		let offset = 0;
		for (const chunk of data) {
			merged.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
			offset += chunk.byteLength;
		}
		return merged;
	}
	if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	return new Uint8Array(data);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label}（超时 ${ms} ms）`)), ms);
		timer.unref();
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Build a faux-backed WebSocket transport for PiClient; keeps every socket so the smoke can force a drop. */
function createCaptureWebSocketFactory(url: string, sockets: WebSocket[]): ByteTransportFactory {
	return (handlers) =>
		new Promise((resolve, reject) => {
			const socket = new WebSocket(url);
			sockets.push(socket);
			let settled = false;
			let resolved = false;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				socket.terminate();
				reject(new Error(`WebSocket 连接超时（${CONNECT_TIMEOUT_MS} ms）：${url}`));
			}, CONNECT_TIMEOUT_MS);
			timeout.unref();
			socket.once("open", () => {
				if (settled) return;
				settled = true;
				resolved = true;
				clearTimeout(timeout);
				resolve({
					send: (chunk) =>
						new Promise<void>((resolveSend, rejectSend) => {
							socket.send(chunk, { binary: true }, (error) => {
								if (error) rejectSend(error instanceof Error ? error : new Error(String(error)));
								else resolveSend();
							});
						}),
					close: () => {
						if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
							socket.close();
						}
					},
				});
			});
			socket.on("message", (data) => {
				if (typeof data === "string" || typeof data === "boolean") return;
				handlers.onData(toUint8Array(data));
			});
			socket.on("error", (error) => {
				if (!settled) {
					settled = true;
					clearTimeout(timeout);
					reject(error instanceof Error ? error : new Error(String(error)));
				} else if (resolved) {
					handlers.onError(error instanceof Error ? error : new Error(String(error)));
				}
			});
			socket.on("close", () => {
				if (resolved) handlers.onClose();
			});
		});
}

/** Inert resource loader: no extensions, skills, prompts, or themes on disk. */
function makeResourceLoader(): AgentSessionServices["resourceLoader"] {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

/** Fresh faux backend over a throwaway temp tree (no real model API is ever contacted). */
async function makeHarness(): Promise<{ backend: CodingAgentPiSessionBackend; faux: FauxHandle; root: string }> {
	const root = mkdtempSync(join(tmpdir(), "pi-p0-smoke-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		provider: "faux",
		models: [
			{ id: "faux-1", name: "Faux One", reasoning: true },
			{ id: "faux-2", name: "Faux Two", reasoning: true },
		],
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });

	const settingsManager = SettingsManager.create(cwd, agentDir);
	const services: AgentSessionServices = {
		cwd,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader: makeResourceLoader(),
		diagnostics: [],
	};
	const backend = await CodingAgentPiSessionBackend.create({
		cwd,
		agentDir,
		sessionDir: join(root, "sessions"),
		services,
	});
	return { backend, faux, root };
}

async function startWireServer(backend: CodingAgentPiSessionBackend): Promise<{ server: PiServer; url: string }> {
	const server = createWebSocketServer(backend, { port: 0 });
	await server.start();
	const address = server.addresses[0];
	if (!address) throw new Error("WebSocket 服务未绑定地址");
	const port = Number(address.slice(address.lastIndexOf(":") + 1));
	return { server, url: `ws://127.0.0.1:${port}/api/pi/v1/ws` };
}

/** Record every applied session_progress event for a session (post-dedup, as seen by listeners). */
function collectProgress(client: PiClient, sessionId: string, out: ProgressEvent[]): void {
	client.onEvent((event) => {
		if (event.type !== "session_progress" || event.sessionId !== sessionId) return;
		const progress = event.progress as { type: string; kind?: string };
		out.push({ sequence: event.sequence, type: progress.type, kind: progress.kind });
	});
}

async function runSmoke(): Promise<boolean> {
	const results: { name: string; ok: boolean; detail?: string }[] = [];
	const record = (name: string, ok: boolean, detail?: string): void => {
		results.push({ name, ok, detail });
		console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
	};

	console.log("P0 smoke — faux provider 端到端（协议 v2 可靠流式）\n");

	const sockets: WebSocket[] = [];
	let server: PiServer | undefined;
	let clientA: PiClient | undefined;
	let clientB: PiClient | undefined;
	let root = "";
	try {
		const { backend, faux, root: harnessRoot } = await makeHarness();
		root = harnessRoot;
		const wired = await startWireServer(backend);
		server = wired.server;
		record("服务启动", true, wired.url);

		faux.setResponses([
			fauxAssistantMessage([
				{ type: "thinking", thinking: "think step one for turn one" },
				{ type: "text", text: "Turn one reply from faux" },
			]),
			fauxAssistantMessage([
				{ type: "thinking", thinking: "think step one for turn two" },
				{ type: "text", text: "Turn two reply from faux" },
			]),
		]);

		clientA = new PiClient({ transportFactory: createCaptureWebSocketFactory(wired.url, sockets) });
		clientB = new PiClient({ transportFactory: createCaptureWebSocketFactory(wired.url, sockets) });

		// --- 1. 首连（客户端 A） ---
		const hello = await withTimeout(clientA.connect(), CONNECT_TIMEOUT_MS, "首连");
		record(
			"首连握手",
			clientA.connectionState === "connected" && hello.protocolVersion === PROTOCOL_VERSION,
			`protocolVersion=${hello.protocolVersion}`,
		);

		// --- 2. 创建会话 + 第一轮 prompt（流式 delta） ---
		const handleA = await clientA.createSession({ model: { provider: "faux", id: "faux-1" }, thinkingLevel: "high" });
		const sessionId = handleA.id;
		const aEvents: ProgressEvent[] = [];
		collectProgress(clientA, sessionId, aEvents);
		await handleA.prompt("hello, first turn");
		const aTurn1 = [...aEvents];
		const deltaKinds = [...new Set(aTurn1.filter((e) => e.type === "assistant_delta").map((e) => e.kind).filter(Boolean))];
		record(
			"首轮 prompt 流式 delta",
			deltaKinds.includes("text") && deltaKinds.includes("thinking"),
			`delta kinds=${deltaKinds.join(", ")}，${aTurn1.length} 个事件`,
		);

		// --- 3. 客户端 B 接上同一会话，跑第二轮 ---
		await withTimeout(clientB.connect(), CONNECT_TIMEOUT_MS, "B 连接");
		const handleB = await clientB.attachSession(sessionId);
		const bEvents: ProgressEvent[] = [];
		collectProgress(clientB, sessionId, bEvents);
		await handleB.prompt("second turn while A is offline");
		const bSeqs = bEvents.map((e) => e.sequence);
		record("B 侧第二轮事件", bSeqs.length > 0, `${bSeqs.length} 个 progress 事件（A 掉线期间）`);

		// --- 4. 断线：terminate A 的 socket（模拟网络中断） ---
		const aDisconnected = new Promise<void>((resolve) => {
			const unsubscribe = clientA!.onConnectionStateChange((change) => {
				if (change.state === "disconnected") {
					unsubscribe();
					resolve();
				}
			});
		});
		const droppedSocket = sockets[0];
		if (droppedSocket && droppedSocket.readyState === WebSocket.OPEN) droppedSocket.terminate();
		await withTimeout(aDisconnected, DROP_TIMEOUT_MS, "断线等待 disconnected");
		record("断线", clientA.connectionState === "disconnected", "socket terminate → disconnected");

		// --- 5. A 重连，attachSession 自动改发 resume 并重放漏掉的事件 ---
		await withTimeout(clientA.connect(), CONNECT_TIMEOUT_MS, "重连");
		const handleA2 = await clientA.attachSession(sessionId);
		const aSeqs = aEvents.map((e) => e.sequence);
		const turn2Max = Math.max(0, ...bSeqs);
		const replayedTurn2 = turn2Max > 0 && bSeqs.every((s) => aSeqs.includes(s));
		record(
			"自动 resume 重放",
			replayedTurn2 && aSeqs.at(-1) === turn2Max,
			`A 应用 ${aSeqs.length} 个事件（掉线前 ${aTurn1.length}，重放 ${aSeqs.length - aTurn1.length}）`,
		);

		// --- 6. 重复事件去重 + 顺序：A 的事件流 == 掉线前事件 + 重放事件，严格递增无重复 ---
		const expected = [...aTurn1.map((e) => e.sequence), ...bSeqs];
		const strictlyIncreasing = aSeqs.every((s, i) => i === 0 || s > aSeqs[i - 1]!);
		record(
			"重复事件去重 / 顺序",
			strictlyIncreasing && JSON.stringify(aSeqs) === JSON.stringify(expected),
			`seq=${aSeqs.length}，unique=${new Set(aSeqs).size}，严格递增=${strictlyIncreasing}`,
		);

		// --- 7. 最终快照一致性：A 恢复后与从未掉线的 B 完全一致 ---
		const tA = handleA2.snapshot?.transcript;
		const tB = handleB.snapshot?.transcript;
		const snapshotsAligned =
			tA !== undefined &&
			tB !== undefined &&
			JSON.stringify(tA) === JSON.stringify(tB) &&
			handleA2.snapshot?.lastSequence === handleB.snapshot?.lastSequence;
		record(
			"最终快照一致性",
			snapshotsAligned,
			`transcript=${tA?.length} items，lastSequence=${handleA2.snapshot?.lastSequence}`,
		);
	} catch (error) {
		record("执行", false, error instanceof Error ? `${error.message}\n${error.stack}` : String(error));
	} finally {
		for (const client of [clientA, clientB]) {
			if (client) {
				try {
					await client.dispose();
				} catch {}
			}
		}
		if (server) {
			try {
				await server.close();
			} catch {}
		}
		if (root) {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {}
		}
	}

	const failed = results.filter((r) => !r.ok).length;
	if (failed === 0) {
		console.log(`\nP0 smoke: ${results.length}/${results.length} 通过 ✅`);
	} else {
		console.log(`\nP0 smoke: ${results.length - failed}/${results.length} 通过，${failed} 失败 ❌`);
	}
	return failed === 0;
}

async function main(): Promise<void> {
	const ok = await runSmoke();
	process.exitCode = ok ? 0 : 1;
}

main().catch((error: unknown) => {
	console.error("\nP0 smoke 异常退出：", error instanceof Error ? (error.stack ?? error.message) : error);
	process.exitCode = 1;
});
