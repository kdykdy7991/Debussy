import type { ByteTransportHandlers } from "@earendil-works/pi-client";
import { describe, expect, it, type Mock, vi } from "vitest";
import { createWebSocketTransportFactory } from "../src/lib/websocket-transport.ts";

class FakeWebSocket extends EventTarget {
	readonly sent: Uint8Array[] = [];
	binaryType: BinaryType = "blob";
	bufferedAmount = 0;
	readyState = 0;
	closeCalls = 0;

	open(): void {
		this.readyState = 1;
		this.dispatchEvent(new Event("open"));
	}

	receive(data: ArrayBuffer | string): void {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}

	fail(): void {
		this.dispatchEvent(new Event("error"));
	}

	send(data: ArrayBufferView): void {
		this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
	}

	close(): void {
		this.closeCalls += 1;
		this.readyState = 3;
		this.dispatchEvent(new Event("close"));
	}
}

interface TestHandlers extends ByteTransportHandlers {
	onData: Mock<(chunk: Uint8Array) => void>;
	onClose: Mock<() => void>;
	onError: Mock<(error: Error) => void>;
}

function createHandlers(): TestHandlers {
	return {
		onData: vi.fn<(chunk: Uint8Array) => void>(),
		onClose: vi.fn<() => void>(),
		onError: vi.fn<(error: Error) => void>(),
	};
}

function createFactory(
	socket: FakeWebSocket,
	maxPendingBytes = 64,
): ReturnType<typeof createWebSocketTransportFactory> {
	return createWebSocketTransportFactory({
		url: "ws://127.0.0.1:8765/api/pi/v1/ws",
		maxPendingBytes,
		createWebSocket: () => socket as unknown as WebSocket,
	});
}

describe("createWebSocketTransportFactory", () => {
	it("connects with binary mode and forwards incoming bytes", async () => {
		const socket = new FakeWebSocket();
		const handlers = createHandlers();
		const connection = createFactory(socket)(handlers);

		expect(socket.binaryType).toBe("arraybuffer");
		socket.open();
		await connection;

		const bytes = Uint8Array.from([1, 2, 3]);
		socket.receive(bytes.buffer);
		expect(handlers.onData).toHaveBeenCalledWith(bytes);
	});

	it("preserves send order", async () => {
		const socket = new FakeWebSocket();
		const connection = createFactory(socket)(createHandlers());
		socket.open();
		const transport = await connection;

		await Promise.all([transport.send(Uint8Array.of(1)), transport.send(Uint8Array.of(2))]);

		expect(socket.sent).toEqual([Uint8Array.of(1), Uint8Array.of(2)]);
	});

	it("rejects a chunk larger than the pending byte limit", async () => {
		const socket = new FakeWebSocket();
		const connection = createFactory(socket, 2)(createHandlers());
		socket.open();
		const transport = await connection;

		await expect(transport.send(Uint8Array.of(1, 2, 3))).rejects.toThrow("exceeds pending byte limit");
	});

	it("reports a runtime error only once", async () => {
		const socket = new FakeWebSocket();
		const handlers = createHandlers();
		const connection = createFactory(socket)(handlers);
		socket.open();
		await connection;

		socket.fail();
		socket.close();

		expect(handlers.onError).toHaveBeenCalledOnce();
		expect(handlers.onClose).not.toHaveBeenCalled();
	});

	it("rejects when the socket fails before opening", async () => {
		const socket = new FakeWebSocket();
		const connection = createFactory(socket)(createHandlers());

		socket.fail();

		await expect(connection).rejects.toThrow("WebSocket transport failed");
	});

	it("makes close idempotent", async () => {
		const socket = new FakeWebSocket();
		const connection = createFactory(socket)(createHandlers());
		socket.open();
		const transport = await connection;

		transport.close();
		transport.close();

		expect(socket.closeCalls).toBe(1);
	});

	it("rejects non-binary messages", async () => {
		const socket = new FakeWebSocket();
		const handlers = createHandlers();
		const connection = createFactory(socket)(handlers);
		socket.open();
		await connection;

		socket.receive("unexpected text");

		expect(handlers.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "WebSocket received a non-binary message" }),
		);
	});
});
