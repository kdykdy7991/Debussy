export interface DialogOptions {
	readonly title?: string;
	readonly confirmLabel?: string;
	readonly destructive?: boolean;
	readonly typeToConfirm?: string;
	readonly inputLabel?: string;
	readonly defaultValue?: string;
	readonly maxLength?: number;
}

export interface DialogRequest {
	readonly id: number;
	readonly kind: "alert" | "confirm" | "prompt";
	readonly message: string;
	readonly options: DialogOptions;
	readonly resolve: (value: string | null) => void;
}

/** Only one decision is visible at a time; leaving the page cancels all pending decisions. */
export class DialogQueue {
	private pending: DialogRequest[] = [];
	private nextId = 0;
	private active = true;
	private readonly listeners = new Set<() => void>();
	readonly getSnapshot = (): DialogRequest | null => this.pending[0] ?? null;
	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	activate(): void {
		this.active = true;
	}
	dispose(): void {
		this.active = false;
		for (const request of this.pending.splice(0)) request.resolve(null);
		for (const listener of this.listeners) listener();
	}
	ask(kind: DialogRequest["kind"], message: string, options: DialogOptions = {}): Promise<string | null> {
		if (!this.active) return Promise.resolve(null);
		return new Promise((resolve) => {
			this.pending.push({ id: this.nextId++, kind, message, options, resolve });
			for (const listener of this.listeners) listener();
		});
	}
	settle(request: DialogRequest, value: string | null): void {
		if (this.pending[0] !== request) return;
		this.pending.shift();
		for (const listener of this.listeners) listener();
		request.resolve(value);
	}
}
