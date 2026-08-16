/**
 * TASK-029: Embed postMessage v1 协议测试（spec 7.2 / 27.5 / 25.3）。
 *
 * 覆盖：合法 init（匿名/带 token）/logout 解码；伪造 protocol/version/type、
 * 非法 payload（非对象、超长 token、非字符串 token）拒绝；iframe -> host
 * 消息信封编码（ready/error/resize 保留全部字段）；长度上限。
 */
import { describe, expect, test } from "vitest";
import {
	decodeEmbedHostMessage,
	type EmbedHostPostMessage,
	type EmbedIframePostMessage,
	encodeEmbedIframeMessage,
	POST_MESSAGE_LAUNCH_TOKEN_MAX_CHARS,
	POST_MESSAGE_PROTOCOL,
	POST_MESSAGE_RESIZE_MAX_HEIGHT,
	POST_MESSAGE_VERSION,
} from "../../src/embed/post-message.ts";

describe("decodeEmbedHostMessage", () => {
	test("decodes anonymous init (no payload) and init with launchToken", () => {
		expect(
			decodeEmbedHostMessage({ protocol: POST_MESSAGE_PROTOCOL, version: POST_MESSAGE_VERSION, type: "init" }),
		).toEqual({ ok: true, message: { type: "init" } });
		expect(
			decodeEmbedHostMessage({
				protocol: POST_MESSAGE_PROTOCOL,
				version: POST_MESSAGE_VERSION,
				type: "init",
				payload: { launchToken: "jws.abc.def" },
			}),
		).toEqual({ ok: true, message: { type: "init", launchToken: "jws.abc.def" } });
	});

	test("decodes logout", () => {
		const result = decodeEmbedHostMessage({
			protocol: POST_MESSAGE_PROTOCOL,
			version: POST_MESSAGE_VERSION,
			type: "logout",
		});
		expect(result).toEqual({ ok: true, message: { type: "logout" } });
	});

	test("rejects non-object, wrong protocol, wrong version", () => {
		expect(decodeEmbedHostMessage("nope")).toEqual({ ok: false, reason: "NOT_OBJECT" });
		expect(decodeEmbedHostMessage([1, 2])).toEqual({ ok: false, reason: "NOT_OBJECT" });
		expect(decodeEmbedHostMessage({ protocol: "other", version: POST_MESSAGE_VERSION, type: "init" })).toEqual({
			ok: false,
			reason: "WRONG_PROTOCOL",
		});
		expect(decodeEmbedHostMessage({ protocol: POST_MESSAGE_PROTOCOL, version: 2, type: "init" })).toEqual({
			ok: false,
			reason: "WRONG_VERSION",
		});
	});

	test("rejects unknown types", () => {
		expect(
			decodeEmbedHostMessage({ protocol: POST_MESSAGE_PROTOCOL, version: POST_MESSAGE_VERSION, type: "steal" }),
		).toEqual({ ok: false, reason: "UNKNOWN_TYPE" });
	});

	test("rejects invalid init payloads (non-object, non-string, empty, oversized token)", () => {
		const base = { protocol: POST_MESSAGE_PROTOCOL, version: POST_MESSAGE_VERSION };
		expect(decodeEmbedHostMessage({ ...base, type: "init", payload: "launch-token" })).toEqual({
			ok: false,
			reason: "INVALID_PAYLOAD",
		});
		expect(decodeEmbedHostMessage({ ...base, type: "init", payload: { launchToken: 42 } })).toEqual({
			ok: false,
			reason: "INVALID_PAYLOAD",
		});
		expect(decodeEmbedHostMessage({ ...base, type: "init", payload: { launchToken: "" } })).toEqual({
			ok: false,
			reason: "INVALID_PAYLOAD",
		});
		expect(
			decodeEmbedHostMessage({
				...base,
				type: "init",
				payload: { launchToken: "x".repeat(POST_MESSAGE_LAUNCH_TOKEN_MAX_CHARS + 1) },
			}),
		).toEqual({ ok: false, reason: "INVALID_PAYLOAD" });
	});

	test("accepts the maximum-size launchToken (boundary)", () => {
		const result = decodeEmbedHostMessage({
			protocol: POST_MESSAGE_PROTOCOL,
			version: POST_MESSAGE_VERSION,
			type: "init",
			payload: { launchToken: "x".repeat(POST_MESSAGE_LAUNCH_TOKEN_MAX_CHARS) },
		});
		expect(result.ok).toBe(true);
		if (result.ok)
			expect(result.message).toEqual({ type: "init", launchToken: "x".repeat(POST_MESSAGE_LAUNCH_TOKEN_MAX_CHARS) });
	});
});

describe("encodeEmbedIframeMessage", () => {
	test("ready carries publicAppId and mode", () => {
		const envelope = encodeEmbedIframeMessage({ type: "ready", publicAppId: "pub_1", mode: "signed_user" });
		expect(envelope).toEqual({
			protocol: POST_MESSAGE_PROTOCOL,
			version: POST_MESSAGE_VERSION,
			type: "ready",
			payload: { publicAppId: "pub_1", mode: "signed_user" },
		});
	});

	test("error carries code and message", () => {
		const envelope = encodeEmbedIframeMessage({ type: "error", code: "E", message: "boom" });
		expect(envelope.payload).toEqual({ code: "E", message: "boom" });
	});

	test("resize carries a bounded height", () => {
		const envelope = encodeEmbedIframeMessage({ type: "resize", height: 480 });
		expect(envelope.payload).toEqual({ height: 480 });
		expect(POST_MESSAGE_RESIZE_MAX_HEIGHT).toBeGreaterThanOrEqual(480);
	});

	test("every iframe message decodes from its own envelope shape", () => {
		const messages: readonly EmbedIframePostMessage[] = [
			{ type: "ready", publicAppId: "pub_1", mode: "anonymous" },
			{ type: "error", code: "X", message: "y" },
			{ type: "resize", height: 100 },
		];
		for (const message of messages) {
			const envelope = encodeEmbedIframeMessage(message);
			expect(envelope.protocol).toBe(POST_MESSAGE_PROTOCOL);
			expect(envelope.version).toBe(POST_MESSAGE_VERSION);
			expect(envelope.type).toBe(message.type);
			expect(envelope.payload).toBeTruthy();
		}
	});
});

describe("type guards", () => {
	test("decoded host messages are structurally typed", () => {
		const result: { ok: boolean; message?: EmbedHostPostMessage } = decodeEmbedHostMessage({
			protocol: POST_MESSAGE_PROTOCOL,
			version: POST_MESSAGE_VERSION,
			type: "init",
			payload: { launchToken: "t" },
		});
		expect(result.ok).toBe(true);
	});
});
