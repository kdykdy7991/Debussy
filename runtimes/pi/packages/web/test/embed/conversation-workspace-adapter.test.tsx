import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { EmbedChatController, EmbedChatState } from "../../src/embed/chat-controller.ts";
import {
	createEmbedWorkspaceStores,
	EmbedConversationWorkspace,
} from "../../src/embed/conversation-workspace-adapter.tsx";

function controllerWith(state: EmbedChatState): EmbedChatController {
	return {
		getState: () => state,
		subscribe: () => () => {},
		newConversation: async () => {},
		openConversation: async () => {},
		send: () => {},
		cancel: () => {},
		reconnect: async () => {},
		close: () => {},
		uploadFile: async () => {},
		removeAttachment: async () => {},
	} as unknown as EmbedChatController;
}

describe("embed ConversationWorkspace adapter", () => {
	test("loads the canonical control Chat presentation rules", () => {
		const css = readFileSync(resolve(__dirname, "../../src/embed/embed.css"), "utf8");
		expect(css).toContain('@import "../admin/styles.css"');
	});

	test("keeps external-store snapshots stable until the controller publishes a change", () => {
		let state: EmbedChatState = {
			conversations: [],
			activeId: null,
			messages: [],
			sending: false,
			uploading: false,
			connectionStatus: "connected",
			attachments: [],
			uploadsEnabled: false,
			error: null,
			rolloverNotice: null,
		};
		const listeners = new Set<() => void>();
		const controller = controllerWith(state);
		controller.getState = () => state;
		controller.subscribe = (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		};
		const stores = createEmbedWorkspaceStores(controller);
		const connectionBefore = stores.connection.getSnapshot();
		const sessionsBefore = stores.sessions.getSnapshot();

		expect(stores.connection.getSnapshot()).toBe(connectionBefore);
		expect(stores.sessions.getSnapshot()).toBe(sessionsBefore);

		const unsubscribe = stores.sessions.subscribe(() => {});
		state = { ...state, sending: true };
		for (const listener of listeners) listener();

		expect(stores.connection.getSnapshot()).not.toBe(connectionBefore);
		expect(stores.sessions.getSnapshot()).not.toBe(sessionsBefore);
		expect(stores.sessions.getSnapshot().submitting).toBe(true);
		unsubscribe();
	});

	test("renders published data through the shared control Chat workspace", () => {
		const state: EmbedChatState = {
			conversations: [
				{
					id: "conv_1",
					publishedAppVersionId: "pav_1",
					status: "active",
					title: "真实会话",
					lastEventSequence: 2,
					createdAt: "2026-08-25T00:00:00.000Z",
				},
			],
			activeId: "conv_1",
			messages: [
				{ id: "user-1", role: "user", text: "真实问题", sequence: 1 },
				{ id: "assistant-1", role: "assistant", text: "真实回答", thinking: "真实思考", sequence: 2 },
			],
			sending: false,
			uploading: false,
			connectionStatus: "connected",
			attachments: [],
			uploadsEnabled: false,
			error: null,
			rolloverNotice: null,
		};
		const markup = renderToStaticMarkup(
			<EmbedConversationWorkspace title="已发布 Agent" controller={controllerWith(state)} />,
		);

		expect(markup).toContain("conversation-workspace--admin");
		expect(markup).toContain("真实会话");
		expect(markup).toContain("真实问题");
		expect(markup).toContain("真实回答");
		expect(markup).toContain("思考过程");
		expect(markup).toContain("真实思考");
		expect(markup).toContain("active-agent-presence");
		expect(markup).toContain("editorial-composer");
		expect(markup).toContain("PUBLISHED CHAT");
		expect(markup).not.toContain("PublishedConversationWorkspace");
		expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="上传文件附件"/);
	});
});
