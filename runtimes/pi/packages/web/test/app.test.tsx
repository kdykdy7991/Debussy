import type { SessionSnapshot } from "@earendil-works/pi-protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../src/app.tsx";
import { hasTerminalOrphanedTurn } from "../src/conversation/ai-message-flow.tsx";
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
		createDebugSession: async () => {},
		openDebugSession: async () => {},
		openDefaultSession: async () => {},
		selectSession: async () => {},
		send: async () => ({ session: snapshot.activeSession ?? ({} as never) }),
		abort: async () => {},
		setThinking: async () => {},
		uploadFiles: async () => {},
		removeAttachment: async () => {},
		dismissUpload: () => {},
		clearError: () => {},
	};
}

describe("App", () => {
	it("renders the disconnected frontend shell", () => {
		const markup = renderToStaticMarkup(
			<App connection={createConnection({ state: "disconnected", error: undefined })} sessions={createSessions()} />,
		);

		expect(markup).toContain("PI INTELLIGENCE");
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
							text: "## 正在回答\n\n包含 **重点**、[链接](https://example.com) 与行内公式 $E = mc^2$。\n\n```ts\nconst left = 0;\nconst right = height.length - 1;\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| Markdown | 完成 |",
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
		expect(markup).not.toContain("ai-cursor");
		expect(markup).toContain("ai-user");
		expect(markup).toContain("active-agent-presence");
		expect(markup).toContain("ai-agent-avatar is-waking");
		// FlowToken 走 react-markdown，输出标准 HTML 元素；不再有 data-streamdown 属性。
		expect(markup).toContain("<h2");
		expect(markup).toContain("<strong");
		expect(markup).toContain('href="https://example.com"');
		// minimal 阶段丢了 katex，行内公式退化为原文。代码块由 react-syntax-highlighter
		// 切成 token span，源代码不再是连续字符串——只验证关键 token 出现。
		expect(markup).toContain('class="language-ts"');
		expect(markup).toContain("const");
		expect(markup).toContain("height");
		expect(markup).toContain("length");
		expect(markup).toContain("<table");
		// FlowToken 字符级淡入：每个 token span 带 inline animation。
		expect(markup).toMatch(/animation:\s*[a-zA-Z-]+\s+0?\.\d+s/);
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

describe("App AI kit conversation (design 复刻)", () => {
	it("renders the AgentTrace rail for a tool turn", () => {
		const activeSession = {
			id: "session-r",
			cwd: "/workspace",
			createdAt: 1,
			updatedAt: 2,
			phase: "idle",
			model: { provider: "oneapi", id: "qwen" },
			thinkingLevel: "off",
			attached: true,
			locked: false,
			revision: 1,
			lastSequence: 0,
			transcript: [
				{ id: "user-1", role: "user", content: [{ type: "text", text: "跑一次检索" }], timestamp: 1 },
				{
					id: "tool-1",
					role: "tool",
					toolCallId: "call_1",
					toolName: "web.search",
					input: { query: "q3" },
					content: [{ type: "text", text: "ok" }],
					timestamp: 2,
					status: "complete",
					isError: false,
				},
				{
					id: "assistant-1",
					role: "assistant",
					content: [{ type: "text", text: "汇总完成。" }],
					model: { provider: "oneapi", id: "qwen" },
					timestamp: 3,
					status: "complete",
					stopReason: "stop",
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

		expect(markup).toContain("ai-rail");
		expect(markup).toContain("ai-trace");
		expect(markup).toContain("ai-trace-evt");
		expect(markup).toContain("web.search");
		expect(markup).toContain("assistant-output-copy");
		expect(markup).toContain("active-agent-presence");
		expect(markup).toContain("ai-agent-avatar is-waking");
	});
});

describe("App AI kit assistant failure states", () => {
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

	it("treats an idle user-only Turn as failed instead of permanently loading", () => {
		const active = {
			id: "session-orphaned",
			cwd: "/workspace",
			createdAt: 1,
			updatedAt: 2,
			phase: "idle",
			model: { provider: "oneapi", id: "qwen" },
			thinkingLevel: "off",
			attached: true,
			locked: false,
			revision: 2,
			lastSequence: 0,
			transcript: [
				{ id: "user-timeout", role: "user", content: [{ type: "text", text: "触发超时" }], timestamp: 1 },
			],
			queuedSteer: [],
			queuedSteerCount: 0,
		} satisfies SessionSnapshot;

		expect(hasTerminalOrphanedTurn(active)).toBe(true);
		expect(hasTerminalOrphanedTurn({ ...active, phase: "turn" })).toBe(false);
	});

	it("shows a fallback failure notice when the LLM errors out without producing text", () => {
		const activeSession = {
			id: "session-err",
			cwd: "/workspace",
			createdAt: 1,
			updatedAt: 2,
			phase: "idle",
			model: { provider: "oneapi", id: "qwen" },
			thinkingLevel: "off",
			attached: true,
			locked: false,
			revision: 1,
			lastSequence: 0,
			transcript: [
				{ id: "user-1", role: "user", content: [{ type: "text", text: "讲个笑话" }], timestamp: 1 },
				{
					id: "assistant-1",
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: { provider: "oneapi", id: "qwen" },
					timestamp: 2,
					status: "error",
					stopReason: "error",
					errorMessage: "REQUEST_TIMEOUT: provider timed out after 30s",
				},
			],
			queuedSteer: [],
			queuedSteerCount: 0,
		} satisfies SessionSnapshot;
		const markup = renderToStaticMarkup(
			<App
				connection={createConnection({ state: "connected", error: undefined })}
				sessions={sessionsWith(activeSession)}
			/>,
		);

		expect(markup).toContain("ai-turn-failure is-error");
		expect(markup).toContain("本次响应未完成");
		expect(markup).toContain("REQUEST_TIMEOUT: provider timed out after 30s");
		// 没有可复制内容时，复制按钮必须消失
		expect(markup).not.toContain("assistant-output-copy");
		// 朗读按钮同样不该出现
		expect(markup).not.toContain("speech-button");
	});

	it("falls back to a generic message when errorMessage is missing", () => {
		const activeSession = {
			id: "session-err2",
			cwd: "/workspace",
			createdAt: 1,
			updatedAt: 2,
			phase: "idle",
			model: { provider: "oneapi", id: "qwen" },
			thinkingLevel: "off",
			attached: true,
			locked: false,
			revision: 1,
			lastSequence: 0,
			transcript: [
				{ id: "user-1", role: "user", content: [{ type: "text", text: "讲个笑话" }], timestamp: 1 },
				{
					id: "assistant-1",
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: { provider: "oneapi", id: "qwen" },
					timestamp: 2,
					status: "error",
					stopReason: "error",
				},
			],
			queuedSteer: [],
			queuedSteerCount: 0,
		} satisfies SessionSnapshot;
		const markup = renderToStaticMarkup(
			<App
				connection={createConnection({ state: "connected", error: undefined })}
				sessions={sessionsWith(activeSession)}
			/>,
		);

		expect(markup).toContain("ai-turn-failure is-error");
		expect(markup).toContain("模型调用失败，请稍后重试。");
	});

	it("shows an aborted notice when the run is cancelled, and keeps any partial text", () => {
		const activeSession = {
			id: "session-abort",
			cwd: "/workspace",
			createdAt: 1,
			updatedAt: 2,
			phase: "idle",
			model: { provider: "oneapi", id: "qwen" },
			thinkingLevel: "off",
			attached: true,
			locked: false,
			revision: 1,
			lastSequence: 0,
			transcript: [
				{ id: "user-1", role: "user", content: [{ type: "text", text: "讲个笑话" }], timestamp: 1 },
				{
					id: "assistant-1",
					role: "assistant",
					content: [{ type: "text", text: "说到一半…" }],
					model: { provider: "oneapi", id: "qwen" },
					timestamp: 2,
					status: "aborted",
					stopReason: "aborted",
					errorMessage: "user pressed stop",
				},
			],
			queuedSteer: [],
			queuedSteerCount: 0,
		} satisfies SessionSnapshot;
		const markup = renderToStaticMarkup(
			<App
				connection={createConnection({ state: "connected", error: undefined })}
				sessions={sessionsWith(activeSession)}
			/>,
		);

		expect(markup).toContain("ai-turn-failure is-aborted");
		expect(markup).toContain("本次响应已中止");
		expect(markup).toContain("user pressed stop");
		// 部分内容仍然要展示
		expect(markup).toContain("说到一半…");
		// 已有部分内容时，复制按钮保留（用户能复制已生成片段）
		expect(markup).toContain("assistant-output-copy");
	});

	it("does not show Stop after an assistant error has become terminal", () => {
		const activeSession = {
			id: "session-stuck",
			cwd: "/workspace",
			createdAt: 1,
			updatedAt: 2,
			phase: "idle" as const,
			model: { provider: "oneapi", id: "qwen" },
			thinkingLevel: "off",
			attached: true,
			locked: false,
			revision: 2,
			lastSequence: 0,
			transcript: [
				{ id: "user-1", role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
				{
					id: "assistant-1",
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: { provider: "oneapi", id: "qwen" },
					timestamp: 2,
					status: "error",
					stopReason: "error",
					errorMessage: "REQUEST_TIMEOUT",
				},
			],
			queuedSteer: [],
			queuedSteerCount: 0,
		} satisfies SessionSnapshot;
		const markup = renderToStaticMarkup(
			<App
				connection={createConnection({ state: "connected", error: undefined })}
				sessions={sessionsWith(activeSession)}
			/>,
		);

		// Terminal timeout/error restores normal composer controls automatically.
		expect(markup).not.toContain("stop-button");
		expect(markup).toContain("send-button");
		// 2. assistant 卡片仍然显示 error（确保错误信息没被吞）
		expect(markup).toContain("assistant-output-card is-error");
		expect(markup).toContain("ai-turn-failure is-error");
		expect(markup).toContain("REQUEST_TIMEOUT");
	});

	it("surfaces sessionSnapshot.error as a dismissible banner instead of swallowing it", () => {
		// Regression: session-level failures (send / attach / abort) used to set
		// sessionSnapshot.error, which no view rendered — the composer just sat
		// in its input box with a dead Send button. Now the error is a banner.
		const markup = renderToStaticMarkup(
			<App
				connection={createConnection({ state: "connected", error: undefined })}
				sessions={createSessions({ ...EMPTY_SESSIONS, error: "Runtime is disposed" })}
			/>,
		);

		expect(markup).toContain("session-error");
		expect(markup).toContain("Runtime is disposed");
		expect(markup).toContain("知道了");
	});
});
