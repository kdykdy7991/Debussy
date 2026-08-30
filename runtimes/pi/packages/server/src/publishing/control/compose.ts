/**
 * Control-plane composition for the web server (spec 33.1-33.3, TASK-013).
 *
 * Called from `startWebServer` only when publishing is enabled. It wires the
 * database + migrations + repositories + capability catalog + source adapter
 * + control HTTP handler, and fails startup (never a silent degradation) when
 * any required piece of the 24.2 configuration is missing.
 */

import type { IncomingMessage } from "node:http";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { agentV2MetricsEnabled } from "../../agent-v2/feature-flag.ts";
import { PostgresClient } from "../../persistence/postgres/client.ts";
import { runMigrations } from "../../persistence/postgres/migrate.ts";
import { createPublishingRepositories } from "../../persistence/postgres/repositories/index.ts";
import type { PublishingRepositories } from "../../publishing/repositories.ts";
import type { HttpRequestHandler } from "../../types.ts";
import type { PublishingConfig } from "../config.ts";
import { parseIdOrThrow, type TenantId } from "../domain/ids.ts";
import { McpSecretBox } from "../mcp/secret-box.ts";
import { PreviewTicketService } from "../preview-ticket.ts";
import type { CapabilityCatalog } from "../runtime-spec/compiler.ts";
import { buildCapabilityCatalog } from "./catalog.ts";
import { createControlHttpHandler } from "./http.ts";
import { createLlmConfigStore } from "./llm-config.ts";
import { ControlService } from "./service.ts";
import { createServerAgentSource } from "./source.ts";
import { readTokenFile, secureEqual } from "./token.ts";

export interface ControlPlaneHandle {
	readonly handler: HttpRequestHandler;
	readonly controlService: ControlService;
	/** Shared Postgres connection (also reused by embed plane). */
	readonly client: PostgresClient;
	/** Shared scoped repositories (also reused by embed plane). */
	readonly repositories: PublishingRepositories;
	/** Capability whitelist used to compile RuntimeSpecs (shared with embed). */
	readonly catalog: CapabilityCatalog;
	/** Preview ticket service (WB-005), shared so embed exchange can consume tickets. */
	readonly previewTicketService: PreviewTicketService;
	readonly mcpSecretBox: McpSecretBox | undefined;
	readonly tenantId: TenantId;
	/** Reuse control-plane bearer authentication without exposing the token. */
	isAuthorized(request: IncomingMessage): boolean;
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
	const mcpSecretBox =
		publishing.mcpSecretMasterKey === undefined ? undefined : new McpSecretBox(publishing.mcpSecretMasterKey);
	const configuredMcpNetworkPolicy = publishing.mcpNetworkPolicy;
	const mcpNetworkPolicy =
		configuredMcpNetworkPolicy === undefined
			? undefined
			: {
					allowHttp: configuredMcpNetworkPolicy.allowHttp,
					allowPrivateNetwork: configuredMcpNetworkPolicy.allowPrivateNetwork,
					allowedPorts:
						configuredMcpNetworkPolicy.allowedPorts === undefined
							? undefined
							: new Set(configuredMcpNetworkPolicy.allowedPorts),
				};
	// MVP: the publishable whitelist is the running agent's own capabilities.
	const catalog = buildCapabilityCatalog(options.services);
	const source = createServerAgentSource({ services: options.services, catalog });
	const previewTicketService = new PreviewTicketService({
		adminToken,
		embedBaseUrl: publishing.embedBaseUrl,
	});
	const controlService = new ControlService({
		repositories,
		catalog,
		embedBaseUrl: publishing.embedBaseUrl,
		previewTicketService,
		llm: createLlmConfigStore(options.services),
		metricsEnabled: agentV2MetricsEnabled(),
		mcpSecretBox,
		mcpNetworkPolicy,
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
		tenantName: bootstrapTenantName,
		source,
	});

	return {
		handler,
		controlService,
		client,
		repositories,
		catalog,
		previewTicketService,
		mcpSecretBox,
		tenantId,
		isAuthorized(request) {
			const header = request.headers.authorization ?? "";
			const match = header.match(/^Bearer\s+(.+)$/);
			return match !== null && secureEqual(match[1]!.trim(), adminToken);
		},
		close: () => client.close(),
	};
}
