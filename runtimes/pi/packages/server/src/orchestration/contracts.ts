import { z } from "zod";

export const bindingSchema = z
	.object({
		mcpServerId: z.string().regex(/^mcp_[0-9a-f-]{36}$/),
		toolName: z.string().min(1).max(200),
		parameter: z
			.string()
			.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
			.refine((s) => !["__proto__", "constructor", "prototype"].includes(s)),
		credential: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
	})
	.strict();

export const settingsSchema = z
	.object({
		allowedModels: z.array(z.string().min(1)).min(1).max(50),
		bindings: z.array(bindingSchema).max(128),
		queueTimeoutMs: z.number().int().min(1000).max(86_400_000).default(3_600_000),
	})
	.strict();
export type OrchestrationSettings = z.infer<typeof settingsSchema>;

export const taskMcpReferenceSchema = z
	.object({
		mcpServerId: z.string().regex(/^mcp_[0-9a-f-]{36}$/),
		revision: z.number().int().positive(),
		toolNames: z.array(z.string().min(1)).max(128),
	})
	.strict();
export const taskSkillReferenceSchema = z
	.object({ skillId: z.string().regex(/^skill_[0-9a-f-]{36}$/), revision: z.number().int().positive() })
	.strict();

export const createIntegrationSchema = z
	.object({
		name: z.string().trim().min(1).max(200),
		configuration: z.unknown(),
		settings: settingsSchema,
	})
	.strict();

export const configurationSchema = z
	.object({
		expectedRevision: z.number().int().positive(),
		expectedDraftRevision: z.number().int().positive().optional(),
		expectedActiveVersion: z.string().optional(),
		mcpServers: z.array(taskMcpReferenceSchema).max(8).optional(),
		skills: z.array(taskSkillReferenceSchema).max(32).optional(),
		systemPrompt: z.string().max(60_000),
		modelId: z.string().min(1),
		parameters: z
			.object({
				reasoning: z
					.object({
						enabled: z.boolean().optional(),
						effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
					})
					.strict()
					.optional(),
			})
			.strict(),
	})
	.strict();

export const eventSchema = z
	.object({
		eventId: z.string().min(1).max(200),
		alarmId: z.string().min(1).max(200),
		input: z.string().min(1).max(48_000),
		workItemId: z.string().uuid().optional(),
		credentials: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().min(4).max(4096)),
		credentialExpiresAt: z.string().datetime(),
	})
	.strict();

export class OrchestrationError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}
