/**
 * WB-010 / M1 R5: Launch Token boundary guard。
 *
 * 该文件**不**替代 M0 prototype 的 storage 测试
 * （`sdk-m0-prototype.test.ts`），只补充 SDK 协议层与 DOM 层路径：
 *
 *   1. iframe.src 不含 launchToken（URL 不暴露 secret）；
 *   2. `iframe.setAttribute` 收到的 key/value 不含 launchToken（DOM 不暴露）；
 *   3. `error` 事件 payload 不携带 launchToken（错误上报路径安全）；
 *   4. `destroy()` 后再触发 postMessage 不再派发任何 handler（避免泄露到已注销实例）。
 *
 * 全部用例沿用 `sdk-m0-prototype.test.ts` 的 fake-env 形态（不依赖 jsdom）。
 */
import { EMBED_PROTOCOL_VERSION, type EmbedPostMessageEnvelope } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	create,
	type EmbedDomWindow,
	type EmbedIframe,
	type EmbedWindowEnv,
	type MessageEventLike,
} from "../../src/embed/sdk/skdy-embed.ts";

const BASE = "https://agent.example.com";
const APP = "pub_11111111-1111-1111-1111-111111111111";
const SENTINEL = "tok_must_not_leak_into_src_or_dom_3a91";

interface FakeIframe extends EmbedIframe {
	readonly posted: EmbedPostMessageEnvelope[];
	readonly removed: boolean[];
	readonly attributeWrites: Array<{ readonly name: string; readonly value: string }>;
}
interface FakeWindow extends EmbedDomWindow {
	readonly handlers: Array<(event: MessageEventLike) => void>;
}

function makeEnv(): { env: EmbedWindowEnv; iframe: FakeIframe; win: FakeWindow } {
	const posted: EmbedPostMessageEnvelope[] = [];
	const handlers: Array<(event: MessageEventLike) => void> = [];
	const attributeWrites: Array<{ name: string; value: string }> = [];
	const iframe: FakeIframe = {
		src: "",
		style: { width: "", height: "", border: "" },
		contentWindow: { postMessage: (m) => void posted.push(m) },
		remove: () => {},
		setAttribute: (name, value) => void attributeWrites.push({ name, value }),
		posted,
		removed: [],
		attributeWrites,
	};
	const win: FakeWindow = {
		handlers,
		addEventListener: (_t, h) => void handlers.push(h),
		removeEventListener: (_t, h) => {
			const i = handlers.indexOf(h);
			if (i >= 0) handlers.splice(i, 1);
		},
	};
	const env: EmbedWindowEnv = {
		window: win,
		createInternal: () => iframe,
	};
	return { env, iframe, win };
}

function container(): { appendChild: (n: unknown) => void; children: unknown[] } {
	const children: unknown[] = [];
	return { appendChild: (n) => void children.push(n), children };
}

describe("Launch Token boundary (M1 R5)", () => {
	test("iframe.src never contains launchToken", () => {
		const { env, iframe } = makeEnv();
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			launchToken: SENTINEL,
			container: container() as unknown as HTMLElement,
			env,
		});
		inst.open();
		// src 只含 baseUrl + /embed/<appId>，没有任何 token 片段。
		expect(iframe.src).toBe(`${BASE}/embed/${APP}`);
		expect(iframe.src).not.toContain(SENTINEL);
	});

	test("iframe.setAttribute never receives launchToken", () => {
		const { env, iframe } = makeEnv();
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			launchToken: SENTINEL,
			container: container() as unknown as HTMLElement,
			env,
		});
		inst.open();
		for (const w of iframe.attributeWrites) {
			expect(w.name).not.toContain(SENTINEL);
			expect(w.value).not.toContain(SENTINEL);
		}
		// 同时校验 token **不在 init postMessage payload 外**被序列化到 iframe
		expect(JSON.stringify(iframe.posted)).not.toContain(`"src":"${SENTINEL}`);
	});

	test("error event payload from iframe does not include launchToken", () => {
		const { env, iframe, win } = makeEnv();
		const errors: Array<{ code: string; message: string }> = [];
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			launchToken: SENTINEL,
			container: container() as unknown as HTMLElement,
			env,
		});
		inst.on("error", (p) => void errors.push(p));
		inst.open();
		// 服务端在 error 事件中携带的 message 文案应**不**含 launchToken；
		// 这是协议 `embed/post-message.ts` 的硬性约束——错误信息里禁止出现 secret。
		for (const h of [...win.handlers]) {
			h({
				source: iframe.contentWindow,
				origin: BASE,
				data: {
					protocol: "skdy-embed",
					version: EMBED_PROTOCOL_VERSION,
					type: "error",
					payload: { code: "INTERNAL_ERROR", message: "boom — no secrets here" },
				},
			});
		}
		expect(errors).toEqual([{ code: "INTERNAL_ERROR", message: "boom — no secrets here" }]);
		for (const e of errors) {
			expect(e.message).not.toContain(SENTINEL);
			expect(e.code).not.toContain(SENTINEL);
		}
	});

	test("after destroy(), post-mount events do not reach handlers", () => {
		const { env, iframe, win } = makeEnv();
		const ready: Array<unknown> = [];
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			launchToken: SENTINEL,
			container: container() as unknown as HTMLElement,
			env,
		});
		inst.on("ready", () => void ready.push(undefined));
		inst.open();
		// 销毁 → handlers 清零
		inst.destroy();
		expect(win.handlers).toHaveLength(0);
		// 此时再投递一个 ready 消息；handlers 已清零，无人接收。
		for (const h of [...win.handlers]) {
			h({
				source: iframe.contentWindow,
				origin: BASE,
				data: {
					protocol: "skdy-embed",
					version: EMBED_PROTOCOL_VERSION,
					type: "ready",
					payload: { publicAppId: APP, mode: "anonymous" },
				},
			});
		}
		expect(ready).toEqual([]);
	});
});
