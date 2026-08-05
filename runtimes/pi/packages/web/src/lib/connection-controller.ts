import { type ConnectionState, type ConnectionStateChange, PiClient } from "@earendil-works/pi-client";
import type { ServerSnapshot } from "@earendil-works/pi-protocol";

export interface PiConnectionClient {
	readonly connectionState: ConnectionState;
	connect(): Promise<ServerSnapshot>;
	disconnect(reason?: string): void;
	dispose(): Promise<void>;
	onConnectionStateChange(listener: (change: ConnectionStateChange) => void): () => void;
}

export interface PiConnectionSnapshot {
	state: ConnectionState;
	error: string | undefined;
}

export interface PiConnectionStore {
	getSnapshot(): PiConnectionSnapshot;
	subscribe(listener: () => void): () => void;
	connect(): Promise<void>;
	disconnect(): void;
}

export class PiConnectionController<TClient extends PiConnectionClient = PiConnectionClient>
	implements PiConnectionStore
{
	readonly #client: TClient;
	readonly #listeners = new Set<() => void>();
	readonly #unsubscribeClient: () => void;
	#snapshot: PiConnectionSnapshot;
	#connectPromise: Promise<void> | undefined;
	#disposed = false;
	#intentionalDisconnect = false;

	constructor(client: TClient) {
		this.#client = client;
		this.#snapshot = { state: client.connectionState, error: undefined };
		this.#unsubscribeClient = client.onConnectionStateChange((change) => {
			const error =
				change.state === "disconnected" && this.#intentionalDisconnect ? undefined : change.error?.message;
			if (change.state === "disconnected") this.#intentionalDisconnect = false;
			this.#setSnapshot({ state: change.state, error });
		});
	}

	get client(): TClient {
		return this.#client;
	}

	getSnapshot = (): PiConnectionSnapshot => this.#snapshot;

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	connect(): Promise<void> {
		if (this.#disposed) return Promise.reject(new Error("Connection controller is disposed"));
		if (this.#snapshot.state === "connected") return Promise.resolve();
		if (this.#connectPromise) return this.#connectPromise;
		this.#intentionalDisconnect = false;

		this.#connectPromise = this.#client
			.connect()
			.then(() => undefined)
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : "连接 Pi Server 失败";
				if (this.#snapshot.state !== "disconnected" || this.#snapshot.error !== message) {
					this.#setSnapshot({ state: "disconnected", error: message });
				}
				throw error;
			})
			.finally(() => {
				this.#connectPromise = undefined;
			});
		return this.#connectPromise;
	}

	disconnect(): void {
		if (this.#disposed || this.#snapshot.state === "disconnected") return;
		this.#intentionalDisconnect = true;
		this.#client.disconnect("用户断开连接");
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribeClient();
		this.#listeners.clear();
		await this.#client.dispose();
	}

	#setSnapshot(snapshot: PiConnectionSnapshot): void {
		this.#snapshot = snapshot;
		for (const listener of this.#listeners) listener();
	}
}

export function createPiConnectionController(
	transportFactory: ConstructorParameters<typeof PiClient>[0]["transportFactory"],
): PiConnectionController<PiClient> {
	return new PiConnectionController(new PiClient({ transportFactory }));
}
