import type { ConnectionState, ConnectionStateChange } from "@earendil-works/pi-client";
import type { ServerSnapshot } from "@earendil-works/pi-protocol";
import { describe, expect, it, vi } from "vitest";
import { type PiConnectionClient, PiConnectionController } from "../src/lib/connection-controller.ts";

class FakeClient implements PiConnectionClient {
	connectionState: ConnectionState = "disconnected";
	readonly connectMock = vi.fn<() => Promise<ServerSnapshot>>();
	readonly disconnectMock = vi.fn<(reason?: string) => void>();
	readonly disposeMock = vi.fn<() => Promise<void>>(async () => {});
	#listener: ((change: ConnectionStateChange) => void) | undefined;

	connect(): Promise<ServerSnapshot> {
		return this.connectMock();
	}

	disconnect(reason?: string): void {
		this.disconnectMock(reason);
		this.emit({ state: "disconnected", error: new Error(reason) });
	}

	dispose(): Promise<void> {
		return this.disposeMock();
	}

	onConnectionStateChange(listener: (change: ConnectionStateChange) => void): () => void {
		this.#listener = listener;
		return () => {
			this.#listener = undefined;
		};
	}

	emit(change: ConnectionStateChange): void {
		this.connectionState = change.state;
		this.#listener?.(change);
	}
}

const SNAPSHOT = {
	serverId: "server-test",
	protocolVersion: 1,
	revision: 1,
	sessions: [],
	models: [],
} satisfies ServerSnapshot;

describe("PiConnectionController", () => {
	it("publishes PiClient connection state changes", async () => {
		const client = new FakeClient();
		client.connectMock.mockImplementation(async () => {
			client.emit({ state: "connecting" });
			client.emit({ state: "connected" });
			return SNAPSHOT;
		});
		const controller = new PiConnectionController(client);
		const listener = vi.fn();
		controller.subscribe(listener);

		await controller.connect();

		expect(controller.getSnapshot()).toEqual({ state: "connected", error: undefined });
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("deduplicates concurrent connection attempts", async () => {
		const client = new FakeClient();
		client.connectMock.mockResolvedValue(SNAPSHOT);
		const controller = new PiConnectionController(client);

		await Promise.all([controller.connect(), controller.connect()]);

		expect(client.connectMock).toHaveBeenCalledOnce();
	});

	it("retains connection errors for the UI", async () => {
		const client = new FakeClient();
		client.connectMock.mockImplementation(async () => {
			const error = new Error("服务不可用");
			client.emit({ state: "connecting" });
			client.emit({ state: "disconnected", error });
			throw error;
		});
		const controller = new PiConnectionController(client);

		await expect(controller.connect()).rejects.toThrow("服务不可用");

		expect(controller.getSnapshot()).toEqual({ state: "disconnected", error: "服务不可用" });
	});

	it("disconnects an active connection", () => {
		const client = new FakeClient();
		client.connectionState = "connected";
		const controller = new PiConnectionController(client);

		controller.disconnect();

		expect(client.disconnectMock).toHaveBeenCalledWith("用户断开连接");
		expect(controller.getSnapshot()).toEqual({ state: "disconnected", error: undefined });
	});
});
