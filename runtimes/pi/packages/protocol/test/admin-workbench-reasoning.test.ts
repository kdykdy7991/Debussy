import { describe, expect, test } from "vitest";
import {
	AGENT_V2_REASONING_AUDIT_ACTION,
	AGENT_V2_REASONING_ERROR_CODES,
	AGENT_V2_REASONING_ERRORS,
	AGENT_V2_REASONING_FACT_STORE,
	AGENT_V2_REASONING_UPDATE_PATHS,
} from "../src/index.ts";

describe("Agent V2 reasoning session-effort contract", () => {
	test("freezes the two update entry points (Control admin + Embed owner)", () => {
		expect(AGENT_V2_REASONING_UPDATE_PATHS).toEqual({
			control: "/api/control/v1/conversations/:conversationId/reasoning",
			embed: "/api/embed/v1/conversations/:conversationId/reasoning",
		});
	});

	test("freezes fact source as the dedicated state store, not an event log", () => {
		expect(AGENT_V2_REASONING_FACT_STORE).toBe("conversation_reasoning_state");
	});

	test("freezes the audit action as an audit-log id, not a conversation_events event type", () => {
		expect(AGENT_V2_REASONING_AUDIT_ACTION).toBe("conversation.reasoning-updated");
	});

	test("freezes reasoning error catalogue and HTTP mapping", () => {
		expect(AGENT_V2_REASONING_ERROR_CODES).toEqual(["REASONING_INVALID_EFFORT", "REASONING_NOT_CONFIGURABLE"]);
		expect(AGENT_V2_REASONING_ERRORS.REASONING_INVALID_EFFORT).toEqual({ httpStatus: 422, retryable: false });
		expect(AGENT_V2_REASONING_ERRORS.REASONING_NOT_CONFIGURABLE).toEqual({ httpStatus: 403, retryable: false });
	});
});
