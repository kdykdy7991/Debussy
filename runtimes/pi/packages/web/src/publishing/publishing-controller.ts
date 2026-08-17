/**
 * Publishing 数据 / 变更编排控制器（ADMIN-003/004/005/006/007）。
 *
 * 不向 React 暴露 fetch / setState；它暴露：
 *
 * - `subscribe(listener)` + `getSnapshot()`：基于 useSyncExternalStore 的
 *   "current page" 快照（list view / detail view / wizard）。
 * - `lock()`：在 401 / 登出 / 锁定时调用，把所有数据清空。
 *
 * 单例 in-module 由 `publishing-app.tsx` 持有；test 通过 `createPublishingController`
 * 创建独立实例。
 */
import type { PublishingApi } from "./api.ts";
import type { AdminAuthController } from "./auth-controller.ts";
import type {
	AgentDefinitionSummary,
	AuditEventSummary,
	LaunchKeySummary,
	PublishedAppDetail,
	PublishedAppSummary,
	PublishedAppVersionSummary,
	TenantInfo,
} from "./types.ts";
import { PublishingApiError } from "./types.ts";

/** Page-level state surfaced to React. */
export type PublishingPage =
	| { readonly kind: "apps" }
	| { readonly kind: "apps-create" }
	| { readonly kind: "app-detail"; readonly appId: string }
	| { readonly kind: "app-detail-tab"; readonly appId: string; readonly tab: DetailTab }
	| { readonly kind: "publish-success"; readonly appId: string; readonly versionId: string };

export type DetailTab = "overview" | "versions" | "keys" | "audit";

export interface PublishingSnapshot {
	readonly page: PublishingPage;
	readonly tenant: TenantInfo | null;
	readonly connected: boolean;
	/** App list view state. */
	readonly apps: ReadonlyArray<PublishedAppSummary>;
	readonly appsLoading: boolean;
	readonly appsError: string | null;
	readonly appsNextCursor: string | null;
	readonly appsStatusFilter: string;
	/** Agent definition list view state. */
	readonly agents: ReadonlyArray<AgentDefinitionSummary>;
	readonly agentsLoading: boolean;
	readonly agentsError: string | null;
	/** Detail view state. */
	readonly detail: PublishedAppDetail | null;
	readonly versions: ReadonlyArray<PublishedAppVersionSummary>;
	readonly launchKeys: ReadonlyArray<LaunchKeySummary>;
	readonly audits: ReadonlyArray<AuditEventSummary>;
	readonly detailLoading: boolean;
	readonly detailError: string | null;
	/** Transient status message for confirm/toast surfaces. */
	readonly lastRequestId: string | null;
}

export type PublishingListener = (snapshot: PublishingSnapshot) => void;

const INITIAL: PublishingSnapshot = {
	page: { kind: "apps" },
	tenant: null,
	connected: false,
	apps: [],
	appsLoading: false,
	appsError: null,
	appsNextCursor: null,
	appsStatusFilter: "",
	agents: [],
	agentsLoading: false,
	agentsError: null,
	detail: null,
	versions: [],
	launchKeys: [],
	audits: [],
	detailLoading: false,
	detailError: null,
	lastRequestId: null,
};

export interface PublishingControllerOptions {
	readonly api: PublishingApi;
	readonly auth: AdminAuthController;
}

export class PublishingController {
	private snapshot: PublishingSnapshot = { ...INITIAL };
	private readonly listeners = new Set<PublishingListener>();
	/** Pending mutations tracked so we can surface `IDEMPOTENCY_IN_PROGRESS`. */
	private readonly inflight = new Set<string>();
	private readonly api: PublishingApi;
	private readonly auth: AdminAuthController;

	constructor(options: PublishingControllerOptions) {
		this.api = options.api;
		this.auth = options.auth;
		// Always read the token through the auth controller so a 401 / lock
		// immediately applies to subsequent calls without rebuilding the API.
		this.api.setTokenProvider(() => this.auth.getToken());
	}

	getSnapshot = (): PublishingSnapshot => this.snapshot;

	subscribe(listener: PublishingListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	isInflight(op: string): boolean {
		return this.inflight.has(op);
	}

	lock(): void {
		this.snapshot = { ...INITIAL };
		for (const listener of this.listeners) listener(this.snapshot);
	}

	goApps(): void {
		this.update({ page: { kind: "apps" } });
		void this.refreshAppList();
	}

	goCreate(): Promise<void> {
		this.update({ page: { kind: "apps-create" }, detail: null });
		return this.refreshAgents();
	}

	goDetail(appId: string, tab: DetailTab = "overview"): void {
		this.update({ page: { kind: "app-detail-tab", appId, tab } });
		void this.refreshDetail(appId, tab);
	}

	async connect(token: string): Promise<void> {
		this.auth.connect(token);
		this.update({ connected: false, detailError: null });
		try {
			const tenant = await this.api.ping();
			if (tenant !== null) {
				this.auth.completeConnection(tenant);
				this.update({ tenant, connected: true });
			} else {
				this.auth.completeConnection({ id: "", name: "bootstrap" });
				this.update({ connected: true });
			}
			await this.refreshAppList();
		} catch (error) {
			if (error instanceof PublishingApiError) {
				if (!this.auth.handleApiError(error)) this.auth.failConnection(error.message);
			} else {
				this.auth.failConnection(String(error));
			}
			this.update({ connected: false, tenant: null, detailError: this.errorMessage(error) });
			throw error;
		}
	}

	lockAuth(): void {
		this.auth.lock();
		this.lock();
	}

	async refreshAppList(): Promise<void> {
		this.update({ appsLoading: true, appsError: null });
		try {
			const result = await this.api.listPublishedApps({
				limit: 50,
				status: this.snapshot.appsStatusFilter === "" ? undefined : this.snapshot.appsStatusFilter,
			});
			this.update({
				apps: result.items,
				appsNextCursor: result.nextCursor,
				appsLoading: false,
				lastRequestId: this.snapshot.lastRequestId,
			});
		} catch (error) {
			this.handleMutationError("apps.refresh", error);
			this.update({ appsLoading: false });
		}
	}

	async loadMoreApps(): Promise<void> {
		const cursor = this.snapshot.appsNextCursor;
		if (cursor === null || this.snapshot.appsLoading) return;
		this.update({ appsLoading: true, appsError: null });
		try {
			const result = await this.api.listPublishedApps({
				limit: 50,
				cursor,
				status: this.snapshot.appsStatusFilter === "" ? undefined : this.snapshot.appsStatusFilter,
			});
			const known = new Set(this.snapshot.apps.map((app) => app.id));
			this.update({
				apps: [...this.snapshot.apps, ...result.items.filter((app) => !known.has(app.id))],
				appsNextCursor: result.nextCursor,
				appsLoading: false,
			});
		} catch (error) {
			this.update({ appsLoading: false, appsError: this.errorMessage(error) });
			this.handleMutationError("apps.load-more", error);
		}
	}

	setStatusFilter(status: string): void {
		this.update({ appsStatusFilter: status });
		void this.refreshAppList();
	}

	async refreshAgents(): Promise<void> {
		this.update({ agentsLoading: true, agentsError: null });
		try {
			const result = await this.api.listAgentDefinitions({ limit: 50 });
			this.update({ agents: result.items, agentsLoading: false });
		} catch (error) {
			this.handleMutationError("agents.refresh", error);
			this.update({ agentsLoading: false, agentsError: this.errorMessage(error) });
		}
	}

	async importCurrentAgent(): Promise<void> {
		this.guardInflight("agents.import", () => this.runImport());
	}

	private async runImport(): Promise<void> {
		try {
			await this.api.importCurrentAgent();
			await this.refreshAgents();
		} catch (error) {
			this.handleMutationError("agents.import", error);
		}
	}

	async refreshDetail(appId: string, tab: DetailTab): Promise<void> {
		this.update({ detailLoading: true, detailError: null });
		try {
			const detail = await this.api.getPublishedApp(appId);
			this.update({ detail });
			await Promise.all([this.refreshVersions(appId), this.refreshLaunchKeys(appId), this.refreshAudits(appId)]);
			this.update({ detailLoading: false, page: { kind: "app-detail-tab", appId, tab } });
		} catch (error) {
			this.handleMutationError("detail.refresh", error);
			this.update({ detailLoading: false, detailError: this.errorMessage(error) });
		}
	}

	private async refreshVersions(appId: string): Promise<void> {
		try {
			const result = await this.api.listVersions({ appId, limit: 50 });
			this.update({ versions: result.items });
		} catch (error) {
			this.handleMutationError("versions.refresh", error);
		}
	}

	private async refreshLaunchKeys(appId: string): Promise<void> {
		try {
			const result = await this.api.listLaunchKeys(appId);
			this.update({ launchKeys: result.items });
		} catch (error) {
			this.handleMutationError("keys.refresh", error);
		}
	}

	private async refreshAudits(appId: string): Promise<void> {
		try {
			const result = await this.api.listAuditEvents({ appId, limit: 50 });
			this.update({ audits: result.items });
		} catch (error) {
			this.handleMutationError("audits.refresh", error);
		}
	}

	async createAppAndVersion(input: {
		readonly agentDefinitionId: string;
		readonly sourceAgentRevision: number;
		readonly name: string;
		readonly accessMode: "anonymous" | "signed_user" | "mixed";
		readonly allowedOrigins: readonly string[];
		readonly theme?: { readonly primaryColor?: string; readonly welcomeMessage?: string };
	}): Promise<{ readonly appId: string; readonly versionId: string } | null> {
		try {
			const app = await this.api.createPublishedApp({
				agentDefinitionId: input.agentDefinitionId,
				name: input.name,
				accessMode: input.accessMode,
				allowedOrigins: input.allowedOrigins,
				theme: input.theme,
			});
			const version = await this.api.createVersion({
				appId: app.id,
				sourceAgentRevision: input.sourceAgentRevision,
			});
			// If the version is ready, immediately activate it (ADMIN-005).
			if (version.version.status === "ready") {
				await this.api.activateVersion({ appId: app.id, versionId: version.version.id });
			}
			this.update({ page: { kind: "publish-success", appId: app.id, versionId: version.version.id } });
			await this.refreshAppList();
			return { appId: app.id, versionId: version.version.id };
		} catch (error) {
			this.handleMutationError("apps.create", error);
			throw error;
		}
	}

	async createVersion(input: {
		readonly appId: string;
		readonly sourceAgentRevision: number;
	}): Promise<string | null> {
		try {
			const version = await this.api.createVersion(input);
			await this.refreshDetail(input.appId, "versions");
			return version.version.id;
		} catch (error) {
			this.handleMutationError("apps.create-version", error);
			throw error;
		}
	}

	async activateVersion(input: { readonly appId: string; readonly versionId: string }): Promise<void> {
		try {
			await this.api.activateVersion(input);
			await this.refreshDetail(input.appId, "versions");
		} catch (error) {
			this.handleMutationError("apps.activate", error);
		}
	}

	async rollbackVersion(input: { readonly appId: string; readonly versionId: string }): Promise<void> {
		try {
			await this.api.rollbackVersion(input);
			await this.refreshDetail(input.appId, "versions");
		} catch (error) {
			this.handleMutationError("apps.rollback", error);
		}
	}

	async suspendApp(input: { readonly appId: string; readonly reason?: string }): Promise<void> {
		try {
			await this.api.suspendApp(input);
			await this.refreshDetail(input.appId, "overview");
		} catch (error) {
			this.handleMutationError("apps.suspend", error);
		}
	}

	async resumeApp(input: { readonly appId: string }): Promise<void> {
		try {
			await this.api.resumeApp(input);
			await this.refreshDetail(input.appId, "overview");
		} catch (error) {
			this.handleMutationError("apps.resume", error);
		}
	}

	async createLaunchKey(input: {
		readonly appId: string;
		readonly keyId: string;
		readonly publicKeyPem: string;
	}): Promise<void> {
		try {
			await this.api.createLaunchKey(input);
			await this.refreshLaunchKeys(input.appId);
		} catch (error) {
			this.handleMutationError("apps.create-launch-key", error);
			throw error;
		}
	}

	async revokeLaunchKey(input: { readonly appId: string; readonly keyId: string }): Promise<void> {
		try {
			await this.api.revokeLaunchKey(input);
			await this.refreshLaunchKeys(input.appId);
		} catch (error) {
			this.handleMutationError("apps.revoke-launch-key", error);
		}
	}

	private update(patch: Partial<PublishingSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		for (const listener of this.listeners) listener(this.snapshot);
	}

	private guardInflight(op: string, run: () => Promise<void>): void {
		if (this.inflight.has(op)) return;
		this.inflight.add(op);
		run().finally(() => {
			this.inflight.delete(op);
		});
	}

	private handleMutationError(op: string, error: unknown): void {
		if (error instanceof PublishingApiError) {
			if (this.auth.handleApiError(error)) return;
		}
		const message = this.errorMessage(error);
		this.update({ detailError: message });
		this.inflight.delete(op);
	}

	private errorMessage(error: unknown): string {
		if (error instanceof PublishingApiError) {
			const request = error.requestId === "" ? "" : ` · requestId: ${error.requestId}`;
			return `${error.code}: ${error.message}${request}`;
		}
		if (error instanceof Error) return error.message;
		return String(error);
	}
}
