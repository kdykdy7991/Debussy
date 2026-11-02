import { describe, expect, it, vi } from "vitest";
import type { ControlService } from "../../src/publishing/control/service.ts";
import { newMcpServerId, newTenantId } from "../../src/publishing/domain/ids.ts";
import { startMcpAutoSync } from "../../src/publishing/mcp/auto-sync.ts";
import type { PublishingRepositories } from "../../src/publishing/repositories.ts";

describe("MCP automatic discovery", () => {
	it("runs another scan when a change notification arrives during a scan", async () => {
		let release: (() => void) | undefined;
		const list = vi.fn(async () => {
			if (list.mock.calls.length === 1)
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			return [];
		});
		const worker = startMcpAutoSync({
			tenantId: newTenantId(),
			repositories: { mcpServers: { list } } as unknown as PublishingRepositories,
			service: {} as ControlService,
			intervalMs: 100000,
		});
		worker.request();
		worker.request();
		release?.();
		await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
		await worker.close();
	});
	it("scans all pages, skips disabled servers, isolates failures and stops on close", async () => {
		const tenantId = newTenantId();
		const now = new Date();
		const servers = Array.from({ length: 102 }, (_, i) => ({
			mcpServerId: newMcpServerId(),
			status: i === 0 ? "disabled" : "enabled",
			updatedAt: now,
		}));
		const list = vi.fn(async (_scope: unknown, _limit: number, cursor?: string) =>
			cursor ? servers.slice(100) : servers.slice(0, 101),
		);
		const sync = vi.fn(async ({ mcpServerId }: { mcpServerId: string }) =>
			mcpServerId === servers[1]!.mcpServerId
				? { ok: false, error: { code: "MCP_TEST_FAILED" } }
				: { ok: true, data: {} },
		);
		const log = vi.fn();
		const worker = startMcpAutoSync({
			tenantId,
			repositories: { mcpServers: { list } } as unknown as PublishingRepositories,
			service: { syncMcpTools: sync } as unknown as ControlService,
			intervalMs: 100000,
			log,
		});
		await worker.run();
		expect(list).toHaveBeenCalledTimes(2);
		expect(sync).toHaveBeenCalledTimes(101);
		expect(sync).not.toHaveBeenCalledWith(expect.objectContaining({ mcpServerId: servers[0]!.mcpServerId }));
		expect(log).toHaveBeenCalledTimes(1);
		await worker.close();
		await worker.run();
		expect(sync).toHaveBeenCalledTimes(101);
	});
	it("coalesces overlapping scans and waits for an in-flight call on shutdown", async () => {
		let release: (() => void) | undefined;
		const list = vi.fn(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return [];
		});
		const worker = startMcpAutoSync({
			tenantId: newTenantId(),
			repositories: { mcpServers: { list } } as unknown as PublishingRepositories,
			service: {} as ControlService,
			intervalMs: 100000,
		});
		const scan = worker.run();
		const close = worker.close();
		release?.();
		await Promise.all([scan, close]);
		expect(list).toHaveBeenCalledTimes(1);
	});
});
