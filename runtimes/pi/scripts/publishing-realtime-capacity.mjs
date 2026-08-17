#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import process from "node:process";
import WebSocket from "ws";

const baseUrl = required("PI_CAPACITY_HTTP_BASE").replace(/\/$/, "");
const publicAppId = required("PI_CAPACITY_PUBLIC_APP_ID");
const origin = process.env.PI_CAPACITY_ORIGIN ?? "https://host-a.example.com";
const connectionCount = positiveInteger("PI_CAPACITY_CONNECTIONS", 1000);
const durationMinutes = positiveNumber("PI_CAPACITY_DURATION_MINUTES", 30);
const batchSize = positiveInteger("PI_CAPACITY_BATCH_SIZE", 25);
const reportPath = process.env.PI_CAPACITY_REPORT_PATH ?? ".artifacts/publishing-realtime-capacity.json";

const sockets = [];
const failures = [];
const latencies = [];
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
const memoryStart = process.memoryUsage();
const startedAt = new Date();
eventLoop.enable();

function required(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function positiveInteger(name, fallback) {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	return value;
}

function positiveNumber(name, fallback) {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
	return value;
}

async function api(path, init) {
	const response = await fetch(`${baseUrl}${path}`, init);
	const body = await response.json().catch(() => undefined);
	if (!response.ok) throw new Error(`${init.method} ${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
	return body.data;
}

async function createSocket(index) {
	const visitorId = `capacity-${process.pid}-${index}-${crypto.randomUUID()}`;
	const exchanged = await api("/api/embed/v1/exchange", {
		method: "POST",
		headers: { "content-type": "application/json", origin },
		body: JSON.stringify({ publicAppId, mode: "anonymous", anonymousVisitorId: visitorId }),
	});
	const conversation = await api("/api/embed/v1/conversations", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${exchanged.accessToken}` },
		body: JSON.stringify({ title: `capacity-${index}` }),
	});
	const ticket = await api(`/api/embed/v1/conversations/${conversation.id}/ws-ticket`, {
		method: "POST",
		headers: { authorization: `Bearer ${exchanged.accessToken}`, origin },
	});
	const realtimeUrl = new URL(ticket.realtimeUrl);
	if (realtimeUrl.protocol === "http:") realtimeUrl.protocol = "ws:";
	if (realtimeUrl.protocol === "https:") realtimeUrl.protocol = "wss:";
	realtimeUrl.searchParams.set("ticket", ticket.ticket);
	const openedAt = performance.now();
	const socket = await new Promise((resolve, reject) => {
		const ws = new WebSocket(realtimeUrl, { headers: { origin } });
		const timeout = setTimeout(() => reject(new Error(`connection ${index} timed out`)), 10_000);
		ws.once("open", () => {
			clearTimeout(timeout);
			resolve(ws);
		});
		ws.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
	latencies.push(performance.now() - openedAt);
	socket.on("close", (code, reason) => failures.push({ index, code, reason: reason.toString() }));
	return socket;
}

async function openAll() {
	for (let offset = 0; offset < connectionCount; offset += batchSize) {
		const size = Math.min(batchSize, connectionCount - offset);
		const settled = await Promise.allSettled(Array.from({ length: size }, (_, i) => createSocket(offset + i)));
		for (const result of settled) {
			if (result.status === "fulfilled") sockets.push(result.value);
			else failures.push({ phase: "open", message: String(result.reason) });
		}
		process.stdout.write(`\rOpened ${sockets.length}/${connectionCount}; failures=${failures.length}`);
		if (failures.length > 0) throw new Error("connection establishment failed");
	}
	process.stdout.write("\n");
}

function percentile(values, fraction) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

async function closeAll() {
	for (const socket of sockets) socket.close(1000, "capacity test complete");
	await new Promise((resolve) => setTimeout(resolve, 250));
}

let exitCode = 0;
try {
	await openAll();
	const holdMs = durationMinutes * 60_000;
	console.log(`Holding ${sockets.length} Realtime connections for ${durationMinutes} minute(s)`);
	const heartbeat = setInterval(() => {
		const open = sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length;
		const mem = process.memoryUsage();
		console.log(`[capacity] open=${open}/${connectionCount} rssMB=${(mem.rss / 1048576).toFixed(1)} heapMB=${(mem.heapUsed / 1048576).toFixed(1)} failures=${failures.length}`);
	}, 60_000);
	await new Promise((resolve) => setTimeout(resolve, holdMs));
	clearInterval(heartbeat);
	if (sockets.some((socket) => socket.readyState !== WebSocket.OPEN) || failures.length > 0) exitCode = 1;
} catch (error) {
	exitCode = 1;
	failures.push({ phase: "run", message: error instanceof Error ? error.message : String(error) });
} finally {
	eventLoop.disable();
	const memoryEnd = process.memoryUsage();
	const report = {
		startedAt: startedAt.toISOString(),
		finishedAt: new Date().toISOString(),
		target: { baseUrl, publicAppId, origin, connectionCount, durationMinutes, batchSize },
		connectionsOpened: sockets.length,
		failures,
		openLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) },
		memory: {
			rssStart: memoryStart.rss,
			rssEnd: memoryEnd.rss,
			heapStart: memoryStart.heapUsed,
			heapEnd: memoryEnd.heapUsed,
		},
		eventLoopDelayMs: { mean: eventLoop.mean / 1e6, p99: eventLoop.percentile(99) / 1e6, max: eventLoop.max / 1e6 },
		passed: exitCode === 0,
	};
	await mkdir(reportPath.slice(0, reportPath.lastIndexOf("/")) || ".", { recursive: true });
	await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	await closeAll();
	console.log(`Report: ${reportPath}`);
	console.log(report.passed ? "Realtime capacity test passed." : "Realtime capacity test failed.");
}

process.exitCode = exitCode;
