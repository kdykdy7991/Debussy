import type { AdminUsageSummary } from "@earendil-works/pi-protocol";
import type { AdminAuthController } from "../../publishing/auth-controller.ts";
import { UsageApi } from "./usage-api.ts";

const FRESH_MS = 60_000;
type Entry = { readonly summary: AdminUsageSummary; readonly savedAt: number };

/** A cache for rolling [from, now) requests, scoped to one authenticated connection. */
export class UsageCache {
	private readonly auth: AdminAuthController;
	private readonly api: UsageApi;
	private readonly entries = new Map<string, Entry>();
	private readonly pending = new Map<string, Promise<AdminUsageSummary>>();
	private generation = 0;
	private tenant: string | null = null;

	constructor(auth: AdminAuthController, api = new UsageApi({ auth })) {
		this.auth = auth;
		this.api = api;
		const snapshot = auth.getSnapshot();
		this.tenant = snapshot.state === "connected" ? (snapshot.tenant?.id ?? null) : null;
		auth.subscribe((next) => {
			const tenant = next.state === "connected" ? (next.tenant?.id ?? null) : null;
			if (tenant === null || tenant !== this.tenant) {
				this.generation++;
				this.entries.clear();
				this.pending.clear();
			}
			this.tenant = tenant;
		});
	}

	get(from: Date): Entry | undefined {
		if (this.auth.getSnapshot().state !== "connected" || this.tenant === null) return undefined;
		return this.entries.get(from.toISOString());
	}

	isFresh(entry: Entry): boolean {
		return Date.now() - entry.savedAt < FRESH_MS;
	}

	request(from: Date, force = false): Promise<AdminUsageSummary> {
		if (this.auth.getSnapshot().state !== "connected" || this.tenant === null) {
			return Promise.reject(new Error("管理连接尚未建立"));
		}
		const key = from.toISOString();
		const existing = this.pending.get(key);
		if (existing && !force) return existing;
		const generation = this.generation;
		const request = this.api
			.getSummary({ from, to: new Date() })
			.then((summary) => {
				if (this.generation === generation && this.pending.get(key) === request) {
					this.entries.set(key, { summary, savedAt: Date.now() });
				}
				return summary;
			})
			.finally(() => {
				if (this.pending.get(key) === request) this.pending.delete(key);
			});
		this.pending.set(key, request);
		return request;
	}
}

const caches = new WeakMap<AdminAuthController, UsageCache>();
export function usageCacheFor(auth: AdminAuthController): UsageCache {
	let cache = caches.get(auth);
	if (!cache) {
		cache = new UsageCache(auth);
		caches.set(auth, cache);
	}
	return cache;
}
