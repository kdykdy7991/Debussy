import { describe, expect, test } from "vitest";
import {
	ADMIN_WORKBENCH_ROUTES,
	ADMIN_WORKBENCH_TERMS,
	legacyPublishingRedirect,
	resolveConversationStatus,
	resolvePublishedAppStatus,
	resolvePublishedAppVersionStatus,
} from "../src/index.ts";

describe("administrator workbench contract", () => {
	test("freezes administrator-facing terminology", () => {
		expect(ADMIN_WORKBENCH_TERMS).toEqual({
			conversation: "Chat",
			agent: "Agent 设计",
			app: "发布",
			usage: "Usage",
			userConversations: "Session 日志",
			settings: "设置",
		});
	});

	test("builds canonical routes from display-prefixed IDs", () => {
		expect(ADMIN_WORKBENCH_ROUTES.conversation).toBe("/");
		expect(ADMIN_WORKBENCH_ROUTES.agent("agent_123")).toBe("/agents/agent_123");
		expect(ADMIN_WORKBENCH_ROUTES.app("app_123")).toBe("/apps/app_123");
		expect(ADMIN_WORKBENCH_ROUTES.usage).toBe("/usage");
		expect(ADMIN_WORKBENCH_ROUTES.userConversation("conv_123")).toBe("/conversations/conv_123");
	});

	test.each([
		["/publishing", "/apps"],
		["/publishing/", "/apps"],
		["/publishing/apps/app_123", "/apps/app_123"],
		["/publishing/apps/app_123/", "/apps/app_123"],
		["/publishing/apps/not-prefixed", null],
		["/publishing/unknown", null],
	] as const)("maps legacy route %s", (pathname, expected) => {
		expect(legacyPublishingRedirect(pathname)).toBe(expected);
	});

	test("marks known statuses actionable", () => {
		expect(resolvePublishedAppStatus("active")).toEqual({ kind: "known", value: "active", readOnly: false });
		expect(resolvePublishedAppVersionStatus("ready")).toEqual({ kind: "known", value: "ready", readOnly: false });
		expect(resolveConversationStatus("archived")).toEqual({
			kind: "known",
			value: "archived",
			readOnly: false,
		});
	});

	test("makes every unknown future status read-only", () => {
		expect(resolvePublishedAppStatus("pausing")).toEqual({ kind: "unknown", value: "pausing", readOnly: true });
		expect(resolvePublishedAppVersionStatus("deploying")).toEqual({
			kind: "unknown",
			value: "deploying",
			readOnly: true,
		});
		expect(resolveConversationStatus("retained")).toEqual({
			kind: "unknown",
			value: "retained",
			readOnly: true,
		});
	});
});
