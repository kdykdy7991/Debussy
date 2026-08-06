import type { SessionSnapshot } from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.tsx";
import type { PiConnectionSnapshot, PiConnectionStore } from "../src/lib/connection-controller.ts";
import type { SessionBrowserSnapshot, SessionBrowserStore } from "../src/lib/session-controller.ts";

const EMPTY_SESSIONS = {
	sessions: [],
	activeSessionId: undefined,
	activeSession: undefined,
	loading: false,
	submitting: false,
	error: undefined,
};

function createConnection(snapshot: PiConnectionSnapshot): PiConnectionStore {
	return {
		getSnapshot: () => snapshot,
		subscribe: () => () => {},
		connect: async () => {},
		disconnect: () => {},
	};
}

function createSessions(snapshot: SessionBrowserSnapshot = EMPTY_SESSIONS): SessionBrowserStore {
	return {
		getSnapshot: () => snapshot,
		subscribe: () => () => {},
		createSession: async () => {},
		selectSession: async () => {},
		send: async () => {},
		abort: async () => {},
	};
}

describe("App", () => {
	it("renders the disconnected frontend shell", () => {
		const markup = renderToStaticMarkup(
			<App connection={createConnection({ state: "disconnected", error: undefined })} sessions={createSessions()} />,
		);

		expect(markup).toContain("EDITORIAL INTELLIGENCE");
		expect(markup).toContain("尚未连接");
		expect(markup).toContain("连接后载入会话");
		expect(markup).toContain("把问题变成一份");
		expect(markup).toContain('data-theme="editorial"');
		expect(markup).toContain("Vision Glass");
		expect(markup).toContain('aria-label="视觉主题"');
	});

	it("renders connection errors with a retry action", () => {
		const markup = renderToStaticMarkup(
			<App
				connection={createConnection({ state: "disconnected", error: "服务不可用" })}
				sessions={createSessions()}
			/>,
		);

		expect(markup).toContain("服务不可用");
		expect(markup).toContain("重新连接");
	});

	it("renders the active transcript and streaming state", () => {
		const activeSession = {
			id: "session-1",
			cwd: "/workspace",
			createdAt: 1,
			updatedAt: 2,
			phase: "turn",
			model: { provider: "oneapi", id: "qwen" },
			thinkingLevel: "medium",
			attached: true,
			locked: false,
			revision: 2,
			transcript: [
				{ id: "user-1", role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1 },
				{
					id: "assistant-1",
					role: "assistant",
					content: [{ type: "text", text: "正在回答" }],
					model: { provider: "oneapi", id: "qwen" },
					timestamp: 2,
					status: "streaming",
				},
			],
			queuedSteer: [],
			queuedSteerCount: 0,
		} satisfies SessionSnapshot;
		const markup = renderToStaticMarkup(
			<App
				connection={createConnection({ state: "connected", error: undefined })}
				sessions={createSessions({
					sessions: [activeSession],
					activeSessionId: activeSession.id,
					activeSession,
					loading: false,
					submitting: false,
					error: undefined,
				})}
			/>,
		);

		expect(markup).toContain("你好");
		expect(markup).toContain("正在回答");
		expect(markup).toContain("streaming-indicator");
		expect(markup).toContain("user-brief");
		expect(markup).toContain("PI ANALYSIS");
	});
});
