/**
 * TASK-029: Embed postMessage v1 通道测试（spec 7.2 / 27.5）。
 *
 * 覆盖：伪造窗口（source 不匹配）丢弃；错误 Origin 丢弃且不成为
 * targetOrigin；未知协议/版本/类型忽略；合法 init 分发 launchToken（仅内存、
 * 即用即弃语义由回调持有）；重复 init；logout 分发；回发使用明确 targetOrigin
 * 且**从不使用 "*"**；无合法宿主（独立打开）时不发送；stop 后不再接收。
 */

import { POST_MESSAGE_PROTOCOL, POST_MESSAGE_VERSION } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	EmbedPostMessageChannel,
	isAllowedHostOrigin,
	type MessageEventLike,
	type ParentWindowLike,
	type WindowLike,
} from "../../src/embed/post-message.ts";

const ALLOWED_ORIGIN = "https://host.example.com";
const OTHER_ORIGIN = "https://evil.example.com";

class FakeWindow implements WindowLike {
	readonly listeners = new Set<(event: MessageEventLike) => void>();
	addEventListener(type: string, listener: (event: MessageEventLike) => void): void {
		if (type === "message") this.listeners.add(listener);
	}
	removeEventListener(type: string, listener: (event: MessageEventLike) => void): void {
		if (type === "message") this.listeners.delete(listener);
	}
	dispatch(event: MessageEventLike): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}

class FakeParent implements ParentWindowLike {
	readonly posted: { message: unknown; targetOrigin: string }[] = [];
	postMessage(message: unknown, targetOrigin: string): void {
		this.posted.push({ message, targetOrigin });
	}
}

function envelope(type: string, payload?: unknown): Record<string, unknown> {
	return { protocol: POST_MESSAGE_PROTOCOL, version: POST_MESSAGE_VERSION, type, payload };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isAllowedHostOrigin", () => {
	test("exact origin match only", () => {
		expect(isAllowedHostOrigin(ALLOWED_ORIGIN, [ALLOWED_ORIGIN])).toBe(true);
		expect(isAllowedHostOrigin("https://host.example.com:8443", [ALLOWED_ORIGIN])).toBe(false);
		expect(isAllowedHostOrigin("https://sub.host.example.com", [ALLOWED_ORIGIN])).toBe(false);
		expect(isAllowedHostOrigin(OTHER_ORIGIN, [ALLOWED_ORIGIN])).toBe(false);
		expect(isAllowedHostOrigin("null", [ALLOWED_ORIGIN])).toBe(false);
	});
});

describe("EmbedPostMessageChannel", () => {
	test("forged window (source mismatch) is dropped", () => {
		const win = new FakeWindow();
		const parent = new FakeParent();
		const onInit = vi.fn();
		const channel = new EmbedPostMessageChannel({
			window: win,
			parent,
			allowedOrigins: [ALLOWED_ORIGIN],
			onInit,
			onLogout: vi.fn(),
		});
		channel.start();
		win.dispatch({ source: {}, origin: ALLOWED_ORIGIN, data: envelope("init", { launchToken: "t" }) });
		expect(onInit).not.toHaveBeenCalled();
	});

	test("wrong origin is dropped and never becomes the targetOrigin", () => {
		const win = new FakeWindow();
		const parent = new FakeParent();
		const onInit = vi.fn();
		const channel = new EmbedPostMessageChannel({
			window: win,
			parent,
			allowedOrigins: [ALLOWED_ORIGIN],
			onInit,
			onLogout: vi.fn(),
		});
		channel.start();
		win.dispatch({ source: parent, origin: OTHER_ORIGIN, data: envelope("init", { launchToken: "t" }) });
		expect(onInit).not.toHaveBeenCalled();
		channel.send({ type: "ready", publicAppId: "pub_1", mode: "anonymous" });
		expect(parent.posted).toHaveLength(0);
	});

	test("unknown protocol/version/type are ignored", () => {
		const win = new FakeWindow();
		const parent = new FakeParent();
		const onInit = vi.fn();
		const channel = new EmbedPostMessageChannel({
			window: win,
			parent,
			allowedOrigins: [ALLOWED_ORIGIN],
			onInit,
			onLogout: vi.fn(),
		});
		channel.start();
		win.dispatch({ source: parent, origin: ALLOWED_ORIGIN, data: { protocol: "other", version: 1, type: "init" } });
		win.dispatch({
			source: parent,
			origin: ALLOWED_ORIGIN,
			data: { protocol: POST_MESSAGE_PROTOCOL, version: 2, type: "init" },
		});
		win.dispatch({ source: parent, origin: ALLOWED_ORIGIN, data: envelope("steal") });
		expect(onInit).not.toHaveBeenCalled();
	});

	test("legal init delivers the launchToken (in-memory only)", () => {
		const win = new FakeWindow();
		const parent = new FakeParent();
		const onInit = vi.fn();
		const channel = new EmbedPostMessageChannel({
			window: win,
			parent,
			allowedOrigins: [ALLOWED_ORIGIN],
			onInit,
			onLogout: vi.fn(),
		});
		channel.start();
		win.dispatch({ source: parent, origin: ALLOWED_ORIGIN, data: envelope("init", { launchToken: "jws-abc" }) });
		expect(onInit).toHaveBeenCalledWith("jws-abc", ALLOWED_ORIGIN);
		// 通道自身不保留 token：回调外无从读取（PD-18）。
		expect(JSON.stringify(channel)).not.toContain("jws-abc");
	});

	test("anonymous init delivers undefined", () => {
		const win = new FakeWindow();
		const parent = new FakeParent();
		const onInit = vi.fn();
		const channel = new EmbedPostMessageChannel({
			window: win,
			parent,
			allowedOrigins: [ALLOWED_ORIGIN],
			onInit,
			onLogout: vi.fn(),
		});
		channel.start();
		win.dispatch({ source: parent, origin: ALLOWED_ORIGIN, data: envelope("init") });
		expect(onInit).toHaveBeenCalledWith(undefined, ALLOWED_ORIGIN);
	});

	test("repeated init dispatches each time (latest wins, no double-start)", () => {
		const win = new FakeWindow();
		const parent = new FakeParent();
		const onInit = vi.fn();
		const channel = new EmbedPostMessageChannel({
			window: win,
			parent,
			allowedOrigins: [ALLOWED_ORIGIN],
			onInit,
			onLogout: vi.fn(),
		});
		channel.start();
		channel.start(); // idempotent
		win.dispatch({ source: parent, origin: ALLOWED_ORIGIN, data: envelope("init", { launchToken: "one" }) });
		win.dispatch({ source: parent, origin: ALLOWED_ORIGIN, data: envelope("init", { launchToken: "two" }) });
		expect(onInit).toHaveBeenCalledTimes(2);
		expect(onInit).toHaveBeenLastCalledWith("two", ALLOWED_ORIGIN);
	});

	test("logout is dispatched", () => {
		const win = new FakeWindow();
		const parent = new FakeParent();
		const onLogout = vi.fn();
		const channel = new EmbedPostMessageChannel({
			window: win,
			parent,
			allowedOrigins: [ALLOWED_ORIGIN],
			onInit: vi.fn(),
			onLogout,
		});
		channel.start();
		win.dispatch({ source: parent, origin: ALLOWED_ORIGIN, data: envelope("logout") });
		expect(onLogout).toHaveBeenCalledTimes(1);
	});

	test("TASK-033: focus and resize-request are dispatched", () => {
		const win = new FakeWindow();
		const parent = new FakeParent();
		const onFocus = vi.fn();
		const onResizeRequest = vi.fn();
		const channel = new EmbedPostMessageChannel({
			window: win,
			parent,
			allowedOrigins: [ALLOWED_ORIGIN],
			onInit: vi.fn(),
			onLogout: vi.fn(),
			onFocus,
			onResizeRequest,
		});
		channel.start();
		win.dispatch({ source: parent, origin: ALLOWED_ORIGIN, data: envelope("focus") });
		win.dispatch({ source: parent, origin: ALLOWED_ORIGIN, data: envelope("resize-request") });
		expect(onFocus).toHaveBeenCalledTimes(1);
		expect(onResizeRequest).toHaveBeenCalledTimes(1);
		// 来源/Origin 校验仍然生效：错误来源的 focus 不触发。
		win.dispatch({ source: {}, origin: ALLOWED_ORIGIN, data: envelope("focus") });
		win.dispatch({ source: parent, origin: OTHER_ORIGIN, data: envelope("focus") });
		expect(onFocus).toHaveBeenCalledTimes(1);
		// 合法 focus 之后可回发（resize 等）。
		channel.send({ type: "resize", height: 480 });
		expect(parent.posted[0]!.targetOrigin).toBe(ALLOWED_ORIGIN);
	});

	test("send uses an explicit targetOrigin, never '*'", () => {
		const win = new FakeWindow();
		const parent = new FakeParent();
		const channel = new EmbedPostMessageChannel({
			window: win,
			parent,
			allowedOrigins: [ALLOWED_ORIGIN],
			onInit: vi.fn(),
			onLogout: vi.fn(),
		});
		channel.start();
		// 未收到合法 init 前不发送。
		channel.send({ type: "ready", publicAppId: "pub_1", mode: "anonymous" });
		expect(parent.posted).toHaveLength(0);
		win.dispatch({ source: parent, origin: ALLOWED_ORIGIN, data: envelope("init") });
		channel.send({ type: "ready", publicAppId: "pub_1", mode: "anonymous" });
		channel.send({ type: "resize", height: 300 });
		expect(parent.posted).toHaveLength(2);
		for (const entry of parent.posted) {
			expect(entry.targetOrigin).toBe(ALLOWED_ORIGIN);
			expect(entry.targetOrigin).not.toBe("*");
		}
		expect((parent.posted[0]!.message as { type: string }).type).toBe("ready");
		expect((parent.posted[1]!.message as { type: string }).type).toBe("resize");
	});

	test("a later message from another allowed origin retargets sends to it", () => {
		const secondOrigin = "https://second.example.com";
		const win = new FakeWindow();
		const parent = new FakeParent();
		const channel = new EmbedPostMessageChannel({
			window: win,
			parent,
			allowedOrigins: [ALLOWED_ORIGIN, secondOrigin],
			onInit: vi.fn(),
			onLogout: vi.fn(),
		});
		channel.start();
		win.dispatch({ source: parent, origin: secondOrigin, data: envelope("init") });
		channel.send({ type: "ready", publicAppId: "pub_1", mode: "anonymous" });
		expect(parent.posted[0]!.targetOrigin).toBe(secondOrigin);
	});

	test("stop removes the listener", () => {
		const win = new FakeWindow();
		const parent = new FakeParent();
		const onInit = vi.fn();
		const channel = new EmbedPostMessageChannel({
			window: win,
			parent,
			allowedOrigins: [ALLOWED_ORIGIN],
			onInit,
			onLogout: vi.fn(),
		});
		channel.start();
		channel.stop();
		win.dispatch({ source: parent, origin: ALLOWED_ORIGIN, data: envelope("init", { launchToken: "t" }) });
		expect(onInit).not.toHaveBeenCalled();
	});
});
