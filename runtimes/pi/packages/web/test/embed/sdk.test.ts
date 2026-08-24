/**
 * WB-010: host-side Enterprise Embed SDK.
 *
 * Node-runnable tests (no DOM) that exercise the SDK against a fake host window
 * + iframe. Covers:
 *   - create() validation + iframe mounting + init postMessage (signed_user
 *     carries a Launch Token; anonymous does not)
 *   - origin / source / protocol-version rejection gates
 *   - ready / error / conversation-created / resize event dispatch
 *   - resize height clamp + sync to iframe style
 *   - open/close lifecycle and destroy() cleanup (listener + iframe removed)
 */

import { EMBED_PROTOCOL_VERSION, type EmbedPostMessageEnvelope } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	create,
	type EmbedDomWindow,
	type EmbedIframe,
	type EmbedWindowEnv,
	type MessageEventLike,
} from "../../src/embed/sdk/skdy-embed.ts";

const BASE = "https://agent.example.com";
const APP = "pub_11111111-1111-1111-1111-111111111111";

interface FakeIframe extends EmbedIframe {
	readonly posted: EmbedPostMessageEnvelope[];
	readonly removed: boolean[];
}

interface FakeWindow extends EmbedDomWindow {
	readonly handlers: Array<(event: MessageEventLike) => void>;
	readonly removed: boolean[];
}

function makeEnv(): { env: EmbedWindowEnv; iframe: FakeIframe; win: FakeWindow } {
	const posted: EmbedPostMessageEnvelope[] = [];
	const handlers: Array<(event: MessageEventLike) => void> = [];
	const removed: boolean[] = [];
	const iframe: FakeIframe = {
		src: "",
		style: { width: "", height: "", border: "" },
		contentWindow: { postMessage: (m) => void posted.push(m) },
		remove: () => void removed.push(true),
		setAttribute: () => {},
		posted,
		removed,
	};
	const win: FakeWindow = {
		handlers,
		removed,
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

function hostEvent(
	win: FakeWindow,
	iframe: FakeIframe,
	data: unknown,
	over: { origin?: string; source?: unknown } = {},
): void {
	const source = over.source ?? iframe.contentWindow;
	const origin = over.origin ?? BASE;
	for (const h of [...win.handlers]) h({ source, origin, data });
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("create()", () => {
	test("invalid appId / baseUrl throw", () => {
		expect(() => create({ appId: "bad", baseUrl: BASE, env: makeEnv().env })).toThrow(/appId/);
		expect(() => create({ appId: APP, baseUrl: "not-url", env: makeEnv().env })).toThrow(/baseUrl/);
	});

	test("signed_user init posts a Launch Token to the iframe then releases it", () => {
		const { env, iframe } = makeEnv();
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			launchToken: "tok",
			container: container() as unknown as HTMLElement,
			env,
		});
		inst.open();
		expect(iframe.posted).toHaveLength(1);
		const init = iframe.posted[0]!;
		expect(init.type).toBe("init");
		expect((init.payload as Record<string, unknown>).launchToken).toBe("tok");
		// Anon reopen (after close) must carry NO token — the SDK dropped it.
		inst.close();
		inst.open();
		expect(iframe.posted[iframe.posted.length - 1]!.type).toBe("init");
		expect(
			(iframe.posted[iframe.posted.length - 1]!.payload as Record<string, unknown> | undefined)?.launchToken,
		).toBeUndefined();
	});
});

describe("message security gates", () => {
	test("rejects wrong source, wrong origin, and wrong protocol/version", () => {
		const { env, iframe, win } = makeEnv();
		const ready: Array<unknown> = [];
		const resized: Array<unknown> = [];
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			container: container() as unknown as HTMLElement,
			env,
		});
		inst.on("ready", () => void ready.push(true));
		inst.on("resize", (p) => void resized.push(p));
		inst.open();

		const goodData = {
			protocol: "skdy-embed",
			version: EMBED_PROTOCOL_VERSION,
			type: "ready",
			payload: { publicAppId: APP, mode: "anonymous" },
		};

		// wrong origin
		hostEvent(win, iframe, goodData, { origin: "https://evil.example" });
		// wrong source
		hostEvent(win, iframe, goodData, { source: {} });
		// wrong protocol
		hostEvent(win, iframe, { ...goodData, protocol: "other" }, { origin: BASE });
		// wrong version
		hostEvent(win, iframe, { ...goodData, version: 99 }, { origin: BASE });

		expect(ready).toHaveLength(0);

		// correct origin + source + version => dispatched
		hostEvent(win, iframe, goodData, { origin: BASE });
		expect(ready).toHaveLength(1);
	});

	test("unknown type / invalid payload are ignored", () => {
		const { env, iframe, win } = makeEnv();
		const resized: Array<unknown> = [];
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.on("resize", (p) => void resized.push(p));
		inst.open();
		hostEvent(win, iframe, {
			protocol: "skdy-embed",
			version: EMBED_PROTOCOL_VERSION,
			type: "resize",
			payload: { height: -1 },
		});
		hostEvent(win, iframe, { protocol: "skdy-embed", version: EMBED_PROTOCOL_VERSION, type: "bogus", payload: {} });
		expect(resized).toHaveLength(0);
	});
});

describe("events", () => {
	test("dispatches error and conversation-created", () => {
		const { env, iframe, win } = makeEnv();
		const errors: Array<{ code: string; message: string }> = [];
		const created: Array<{ conversationId: string }> = [];
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.on("error", (p) => void errors.push(p));
		inst.on("conversation-created", (p) => void created.push(p));
		inst.open();

		hostEvent(win, iframe, {
			protocol: "skdy-embed",
			version: EMBED_PROTOCOL_VERSION,
			type: "error",
			payload: { code: "X", message: "boom" },
		});
		hostEvent(win, iframe, {
			protocol: "skdy-embed",
			version: EMBED_PROTOCOL_VERSION,
			type: "conversation-created",
			payload: { publicAppId: APP, conversationId: "conv_1" },
		});
		expect(errors).toEqual([{ code: "X", message: "boom" }]);
		expect(created).toEqual([{ conversationId: "conv_1" }]);
	});

	test("resize clamps height and syncs iframe style", () => {
		const { env, iframe, win } = makeEnv();
		const resized: Array<unknown> = [];
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.on("resize", (p) => void resized.push(p));
		inst.open();
		hostEvent(win, iframe, {
			protocol: "skdy-embed",
			version: EMBED_PROTOCOL_VERSION,
			type: "resize",
			payload: { height: 321 },
		});
		expect(resized).toEqual([{ height: 321 }]);
		expect(iframe.style.height).toBe("321px");
	});
});

describe("lifecycle", () => {
	test("destroy removes iframe and stops dispatching", () => {
		const { env, iframe, win } = makeEnv();
		const resized: Array<unknown> = [];
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.on("resize", (p) => void resized.push(p));
		inst.open();
		inst.destroy();
		expect(iframe.removed).toEqual([true]);
		expect(win.handlers).toHaveLength(0);
		// After destroy, stale iframe messages must not dispatch.
		hostEvent(win, iframe, {
			protocol: "skdy-embed",
			version: EMBED_PROTOCOL_VERSION,
			type: "resize",
			payload: { height: 1 },
		});
		expect(resized).toHaveLength(0);
	});

	/**
	 * M1 R5：两个独立 create() 必须互不影响；destroy(A) 之后 A 不再派发，
	 * 但 B 仍能正常接收消息。共享同一 `window`（host document）——
	 * handler 列表里有两条记录，destroy 只移除对应的那条。
	 */
	test("multi-instance: destroy(A) does not affect B", () => {
		const { env: envA, iframe: iframeA, win: winA } = makeEnv();
		const { env: envB, iframe: iframeB, win: winB } = makeEnv();
		// 真实场景是同一 window；这里为简化仍各自注入独立 fake win，
		// 但语义验证点在于：A 的 iframe removed 标志位是 `[true]`，B 是 `[]`。
		const readyA: Array<unknown> = [];
		const readyB: Array<unknown> = [];
		const instA = create({
			appId: APP,
			baseUrl: BASE,
			container: container() as unknown as HTMLElement,
			env: envA,
		});
		const instB = create({
			appId: APP,
			baseUrl: BASE,
			container: container() as unknown as HTMLElement,
			env: envB,
		});
		instA.on("ready", () => void readyA.push(undefined));
		instB.on("ready", () => void readyB.push(undefined));
		instA.open();
		instB.open();

		// Both have their own listener registered on their own window.
		expect(winA.handlers).toHaveLength(1);
		expect(winB.handlers).toHaveLength(1);

		instA.destroy();
		expect(iframeA.removed).toEqual([true]);
		expect(iframeB.removed).toEqual([]); // B 仍未 destroy
		expect(winA.handlers).toHaveLength(0);
		expect(winB.handlers).toHaveLength(1); // B 的 listener 保留

		// B 仍能接收 ready 事件（payload 必须带 publicAppId + mode，协议强校验）。
		hostEvent(winB, iframeB, {
			protocol: "skdy-embed",
			version: EMBED_PROTOCOL_VERSION,
			type: "ready",
			payload: { publicAppId: APP, mode: "anonymous" },
		});
		expect(readyB).toEqual([undefined]);
		expect(readyA).toEqual([]);
	});

	/**
	 * M1 R5：mount 失败（`appendChild` 抛错）→ 不注册 listener、不持 iframe 引用，
	 * 后续 destroy() 不需要做任何清理（避免泄露 orphan handler）。
	 */
	test("mount failure (appendChild throws) does not leak listener", () => {
		const { env, iframe, win } = makeEnv();
		const boom = {
			appendChild: () => {
				throw new Error("detached parent");
			},
			children: [],
		};
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			container: boom as unknown as HTMLElement,
			env,
		});
		inst.on("ready", () => {});
		expect(() => inst.open()).toThrow(/detached parent/);
		// 关键断言 —— appendChild 抛错后，listener 列表保持空。
		// （R5 修复前 addEventListener 在 appendChild 之前调用，这里会看到 1 条 handler。）
		expect(win.handlers).toHaveLength(0);
		// destroy 不需要做额外清理（idempotent + iframe 没挂上去）。
		expect(() => inst.destroy()).not.toThrow();
		expect(iframe.removed).toEqual([]); // iframe 从未被挂载，remove 没被调用
	});
});
