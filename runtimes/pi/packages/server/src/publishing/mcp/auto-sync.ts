import type { ControlService } from "../control/service.ts";
import type { TenantId } from "../domain/ids.ts";
import type { PublishingRepositories } from "../repositories.ts";

/** Periodic bounded polling; a scan never overlaps another scan from this process. */
export function startMcpAutoSync(options: {
	readonly tenantId: TenantId;
	readonly repositories: PublishingRepositories;
	readonly service: ControlService;
	readonly intervalMs?: number;
	readonly log?: (message: string) => void;
}): { close(): Promise<void>; run(): Promise<void>; request(): void } {
	let closed = false;
	let requested = false;
	let running: Promise<void> | undefined;
	const abort = new AbortController();
	const run = (): Promise<void> => {
		if (closed) return Promise.resolve();
		if (running !== undefined) return running;
		running = (async () => {
			const servers = [];
			let cursor: string | undefined;
			do {
				const page = await options.repositories.mcpServers.list({ tenantId: options.tenantId }, 100, cursor);
				servers.push(...page.slice(0, 100));
				const last = page[99];
				cursor = page.length > 100 && last ? `${last.updatedAt.toISOString()}|${last.mcpServerId}` : undefined;
			} while (cursor !== undefined && !closed);
			for (const server of servers) {
				if (closed) break;
				if (server.status !== "enabled") continue;
				try {
					const result = await options.service.syncMcpTools({
						tenantId: options.tenantId,
						mcpServerId: server.mcpServerId,
						signal: abort.signal,
					});
					if (!result.ok && !closed)
						options.log?.(`MCP automatic sync failed (${server.mcpServerId}): ${result.error.code}`);
				} catch {
					if (!closed) options.log?.(`MCP automatic sync failed (${server.mcpServerId})`);
				}
			}
		})()
			.catch(() => {
				if (!closed) options.log?.("MCP automatic sync scan failed");
			})
			.finally(() => {
				running = undefined;
				if (requested && !closed) {
					requested = false;
					void run();
				}
			});
		return running;
	};
	const timer = setInterval(() => {
		void run();
	}, options.intervalMs ?? 60_000);
	timer.unref();
	void run();
	return {
		run,
		request() {
			if (closed) return;
			if (running !== undefined) requested = true;
			else void run();
		},
		async close() {
			closed = true;
			clearInterval(timer);
			abort.abort();
			await running;
		},
	};
}
