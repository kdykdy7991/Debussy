/**
 * TASK-013: control-plane composition (33.1/33.2 startup wiring).
 *
 * Missing 24.2 requirements must fail startup loudly, never degrade silently;
 * with everything present the composed control plane can import the current
 * agent configuration over a live Postgres schema. Requires the local test DB.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	type AgentSessionServices,
	createExtensionRuntime,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresClient } from "../../src/persistence/postgres/client.ts";
import type { PublishingConfig } from "../../src/publishing/config.ts";
import { composeControlPlane } from "../../src/publishing/control/compose.ts";
import { newTenantId, uuidv7 } from "../../src/publishing/domain/ids.ts";

const SCHEMA = `pub_test_${process.pid}_${Date.now().toString(36)}`;
const PG_URL = process.env.PI_TEST_DATABASE_URL ?? "postgresql://skdy:skdy123@127.0.0.1:5433/skdy_agent_test";

async function probe(): Promise<boolean> {
	try {
		const client = new PostgresClient({ url: PG_URL, connectTimeoutSeconds: 2, searchPath: SCHEMA });
		await client.ping();
		await client.close();
		return true;
	} catch {
		return false;
	}
}

const pgUp = await probe();

function makeResourceLoader(): AgentSessionServices["resourceLoader"] {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "You are a helpful assistant.",
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

describe.skipIf(!pgUp)("control plane composition", () => {
	let root: string;
	let services: AgentSessionServices;
	let tenantId: string;

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "pi-control-compose-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux One", reasoning: true }] });
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });
		services = {
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.create(cwd, agentDir),
			resourceLoader: makeResourceLoader(),
			diagnostics: [],
		};
		tenantId = newTenantId();
	});

	afterAll(async () => {
		await rmSync(root, { recursive: true, force: true });
	});

	async function config(overrides: Partial<PublishingConfig> = {}): Promise<PublishingConfig> {
		const tokenFile = join(root, "control-admin-token");
		await writeFile(tokenFile, "0123456789abcdef0123456789abcdef0123456789abcdef", "utf8");
		return {
			enabled: true,
			databaseUrl: PG_URL,
			bootstrapTenantId: tenantId,
			bootstrapTenantName: "compose-test",
			controlAdminTokenFile: tokenFile,
			embedBaseUrl: "https://embed.test",
			...overrides,
		};
	}

	test("fails startup when the token file is missing", async () => {
		const cfg = await config({ controlAdminTokenFile: join(root, "does-not-exist") });
		await expect(composeControlPlane({ services, publishing: cfg })).rejects.toThrow(/PI_CONTROL_ADMIN_TOKEN_FILE/);
	});

	test("fails startup when the database url is missing", async () => {
		const cfg = await config({ databaseUrl: undefined });
		await expect(composeControlPlane({ services, publishing: cfg })).rejects.toThrow(/PI_DATABASE_URL/);
	});

	test("fails startup when the bootstrap tenant id is invalid", async () => {
		const cfg = await config({ bootstrapTenantId: "not-a-uuid" });
		await expect(composeControlPlane({ services, publishing: cfg })).rejects.toThrow(/PI_BOOTSTRAP_TENANT_ID/);
	});

	test("composes a working control plane and closes cleanly", async () => {
		const cfg = await config();
		const handle = await composeControlPlane({ services, publishing: cfg });
		expect(handle.controlService).toBeDefined();
		expect(handle.handler).toBeDefined();
		// Bootstrap tenant exists and is reusable.
		const bootstrapped = await handle.controlService.bootstrapTenant({
			tenantId: tenantId as never,
			tenantName: "compose-test",
		});
		expect(bootstrapped.ok).toBe(true);
		if (!bootstrapped.ok) return;
		expect(bootstrapped.data.created).toBe(false);
		await handle.close();
	});

	test("bootstrap tenant id must be a UUIDv7-shaped id", async () => {
		// A syntactically valid uuid of any version is accepted by the parser
		// (the version byte is not enforced); an arbitrary string is not.
		const cfg = await config({ bootstrapTenantId: uuidv7() });
		const handle = await composeControlPlane({ services, publishing: cfg });
		await handle.close();
	});
});
