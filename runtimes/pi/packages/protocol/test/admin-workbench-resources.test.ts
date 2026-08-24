import { describe, expect, test } from "vitest";
import {
	AGENT_V2_MCP_ERROR_CODES,
	AGENT_V2_MCP_ERRORS,
	AGENT_V2_SKILL_ERROR_CODES,
	AGENT_V2_SKILL_ERRORS,
} from "../src/index.ts";

describe("Agent V2 Skill + MCP management contract (M0 candidate)", () => {
	test("freezes Skill error catalogue and HTTP mapping", () => {
		expect(AGENT_V2_SKILL_ERROR_CODES).toEqual([
			"SKILL_NOT_FOUND",
			"SKILL_INVALID",
			"SKILL_IMPORT_REJECTED",
			"SKILL_REVISION_NOT_FOUND",
		]);
		expect(AGENT_V2_SKILL_ERRORS.SKILL_NOT_FOUND).toEqual({ httpStatus: 404, retryable: false });
		expect(AGENT_V2_SKILL_ERRORS.SKILL_INVALID).toEqual({ httpStatus: 422, retryable: false });
	});

	test("freezes MCP error catalogue and HTTP mapping", () => {
		expect(AGENT_V2_MCP_ERROR_CODES).toEqual([
			"MCP_SERVER_NOT_FOUND",
			"MCP_TEST_FAILED",
			"MCP_SYNC_FAILED",
			"MCP_BINDING_VIOLATION",
		]);
		expect(AGENT_V2_MCP_ERRORS.MCP_SERVER_NOT_FOUND).toEqual({ httpStatus: 404, retryable: false });
		expect(AGENT_V2_MCP_ERRORS.MCP_TEST_FAILED).toEqual({ httpStatus: 422, retryable: true });
		expect(AGENT_V2_MCP_ERRORS.MCP_BINDING_VIOLATION).toEqual({ httpStatus: 409, retryable: false });
	});
});
