import type { SessionSnapshot } from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.tsx";
import type { SpeechControllerSource } from "../src/features/voice/types.ts";
import type { PiConnectionSnapshot, PiConnectionStore } from "../src/lib/connection-controller.ts";
import type { SessionBrowserSnapshot, SessionBrowserStore } from "../src/lib/session-controller.ts";

const EMPTY_SESSIONS = {
	sessions: [],
	activeSessionId: undefined,
	activeSession: undefined,
	uploads: [],
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
		openDefaultSession: async () => {},
		selectSession: async () => {},
		send: async () => ({ session: snapshot.activeSession ?? ({} as never) }),
		abort: async () => {},
		uploadFiles: async () => {},
		removeAttachment: async () => {},
		dismissUpload: () => {},
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
		expect(markup).toContain("为下一阶段制定实施计划");
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
			lastSequence: 0,
			transcript: [
				{ id: "user-1", role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1 },
				{
					id: "assistant-1",
					role: "assistant",
					content: [
						{
							type: "text",
							text: "## 正在回答\n\n包含 **重点** 和 [链接](https://example.com)。\n\n| 项目 | 状态 |\n| --- | --- |\n| Markdown | 完成 |",
						},
					],
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
					uploads: [],
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
		expect(markup).toContain("<h2>正在回答</h2>");
		expect(markup).toContain("<strong>重点</strong>");
		expect(markup).toContain('<a href="https://example.com">链接</a>');
		expect(markup).toContain("<table>");
	});
});

describe("App attachment UI", () => {
	it("renders attached file chips above the composer", () => {
		const activeSession = {
			id: "session-1",
			cwd: "/workspace",
			createdAt: 1,
			updatedAt: 2,
			phase: "idle",
			model: { provider: "oneapi", id: "qwen" },
			thinkingLevel: "off",
			attached: true,
			locked: false,
			lastSequence: 0,
			revision: 1,
			transcript: [],
			queuedSteer: [],
			queuedSteerCount: 0,
			attachments: [
				{
					id: "upload-1",
					name: "notes.txt",
					mediaType: "text/plain",
					size: 3,
					sha256: "abc",
					status: "ready",
					scope: "session",
					createdAt: 1,
				},
			],
		} satisfies SessionSnapshot;
		const markup = renderToStaticMarkup(
			<App
				connection={createConnection({ state: "connected", error: undefined })}
				sessions={createSessions({
					sessions: [activeSession],
					activeSessionId: activeSession.id,
					activeSession,
					uploads: [],
					loading: false,
					submitting: false,
					error: undefined,
				})}
			/>,
		);

		expect(markup).toContain("composer-attachments");
		expect(markup).toContain("notes.txt");
		expect(markup).toContain('aria-label="移除 notes.txt"');
		expect(markup).toContain('aria-label="上传文件附件"');
	});
});

describe("App speech read-aloud", () => {
	const completeAssistantSession = {
		id: "session-1",
		cwd: "/workspace",
		createdAt: 1,
		updatedAt: 2,
		phase: "idle",
		model: { provider: "oneapi", id: "qwen" },
		thinkingLevel: "off",
		attached: true,
		locked: false,
		lastSequence: 0,
		revision: 1,
		transcript: [
			{ id: "user-1", role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1 },
			{
				id: "assistant-1",
				role: "assistant",
				content: [{ type: "text", text: "这是回答。" }],
				model: { provider: "oneapi", id: "qwen" },
				timestamp: 2,
				status: "complete",
				stopReason: "stop",
			},
		],
		queuedSteer: [],
		queuedSteerCount: 0,
	} satisfies SessionSnapshot;

	function sessionsWith(active: SessionSnapshot): SessionBrowserStore {
		return createSessions({
			sessions: [active],
			activeSessionId: active.id,
			activeSession: active,
			uploads: [],
			loading: false,
			submitting: false,
			error: undefined,
		});
	}

	it("renders read-aloud buttons when the server advertises voice", () => {
		const speechSource: SpeechControllerSource = {
			snapshot: {
				serverId: "server-1",
				protocolVersion: 4,
				revision: 1,
				sessions: [],
				models: [],
				voice: { available: true, live: false, defaultProfile: "default" },
			},
			startSpeech: async () => {
				throw new Error("unused in render");
			},
		};
		const connection: PiConnectionStore & { client: SpeechControllerSource } = {
			getSnapshot: () => ({ state: "connected", error: undefined }),
			subscribe: () => () => {},
			connect: async () => {},
			disconnect: () => {},
			client: speechSource,
		};
		const markup = renderToStaticMarkup(
			<App connection={connection} sessions={sessionsWith(completeAssistantSession)} />,
		);
		expect(markup).toContain("speech-button");
		expect(markup).toContain("朗读");
	});

	it("hides read-aloud buttons when voice capability is absent", () => {
		const markup = renderToStaticMarkup(
			<App
				connection={createConnection({ state: "connected", error: undefined })}
				sessions={sessionsWith(completeAssistantSession)}
			/>,
		);
		expect(markup).not.toContain("speech-button");
	});
});
