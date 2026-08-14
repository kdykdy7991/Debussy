/**
 * Control-plane composition for the web server (spec 33.1-33.3, TASK-013).
 *
 * Called from `startWebServer` only when publishing is enabled. It wires the
 * database + migrations + repositories + capability catalog + source adapter
 * + control HTTP handler, and fails startup (never a silent degradation) when
 * any required piece of the 24.2 configuration is missing.
 */
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { PostgresClient } from "../../persistence/postgres/client.ts";
import { runMigrations } from "../../persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../persistence/postgres/repositories/index.ts";
import type { PublishingRepositories } from "../../publishing/repositories.ts";
import type { HttpRequestHandler } from "../../types.ts";
import type { PublishingConfig } from "../config.ts";
import { parseIdOrThrow } from "../domain/ids.ts";
import { buildCapabilityCatalog } from "./catalog.ts";
import { createControlHttpHandler } from "./http.ts";
import { ControlService } from "./service.ts";
import { createServerAgentSource } from "./source.ts";
import { readTokenFile } from "./token.ts";

export interface ControlPlaneHandle {
	readonly handler: HttpRequestHandler;
	readonly controlService: ControlService;
	/** 共享 Postgres 连接；embed 数据面组合复用（避免二次建连）。 */
	readonly client: PostgresClient;
	/** 共享作用域仓库集合；embed 数据面组合复用。 */
	readonly repositories: PublishingRepositories;
	close(): Promise<void>;
}

/**
 * Build the control plane against the running server's agent services.
 * Throws on any missing 24.2 requirement so startup fails loudly.
 */
export async function composeControlPlane(options: {
	readonly services: AgentSessionServices;
	readonly publishing: PublishingConfig;
	readonly log?: (message: string) => void;
}): Promise<ControlPlaneHandle> {
	const log = options.log ?? console.log.bind(console);
	const publishing = options.publishing;

	const tokenFile = publishing.controlAdminTokenFile;
	if (tokenFile === undefined || tokenFile === "") {
		throw new Error("PI_CONTROL_ADMIN_TOKEN_FILE is required when publishing is enabled");
	}
	let adminToken: string;
	try {
		adminToken = await readTokenFile(tokenFile);
	} catch (error) {
		throw new Error(
			`cannot read PI_CONTROL_ADMIN_TOKEN_FILE (${tokenFile}): ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const databaseUrl = publishing.databaseUrl;
	if (databaseUrl === undefined || databaseUrl === "") {
		throw new Error("PI_DATABASE_URL is required when publishing is enabled");
	}
	const bootstrapTenantId = publishing.bootstrapTenantId;
	const bootstrapTenantName = publishing.bootstrapTenantName;
	if (bootstrapTenantId === undefined || bootstrapTenantName === undefined) {
		throw new Error("PI_BOOTSTRAP_TENANT_ID and PI_BOOTSTRAP_TENANT_NAME are required when publishing is enabled");
	}
	const tenantId = parseIdOrThrow("TenantId", bootstrapTenantId, "PI_BOOTSTRAP_TENANT_ID");

	const client = new PostgresClient({ url: databaseUrl });
	try {
		await client.ping();
		await runMigrations(client);
	} catch (error) {
		await client.close().catch(() => {});
		throw error;
	}
	const repositories = createPublishingRepositories(client);

	// MVP: the publishable whitelist is the running agent's own capabilities.
	const catalog = buildCapabilityCatalog(options.services);
	const source = createServerAgentSource({ services: options.services, catalog });
	const controlService = new ControlService({
		repositories,
		catalog,
		embedBaseUrl: publishing.embedBaseUrl,
	});

	const bootstrapped = await controlService.bootstrapTenant({
		tenantId,
		tenantName: bootstrapTenantName,
	});
	if (!bootstrapped.ok) {
		await client.close().catch(() => {});
		throw new Error(`bootstrap tenant failed: ${bootstrapped.error.message}`);
	}
	log(
		`control plane ready: tenant ${bootstrapped.data.tenant.tenantId} (${bootstrapped.data.created ? "created" : "existing"})`,
	);

	const handler = createControlHttpHandler({
		service: controlService,
		repositories,
		adminToken,
		tenantId,
		source,
	});

	return {
		handler,
		controlService,
		client,
		repositories,
		close: () => client.close(),
	};
}
