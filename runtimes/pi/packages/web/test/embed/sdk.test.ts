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
	EmbedInstanceBrokenError,
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

/**
 * M1 R7：构造一个**共享** fake window（host document），让多个 create()
 * 共用同一消息总线。`makeEnv` 会生成独立 win——只用于"单实例"测试。
 *
 * 用法：
 *   const { iframe: iframeA, win, env } = makeSharedEnv();
 *   const { iframe: iframeB } = makeSharedEnv(win);
 *   // env.window === win；createInternal 每次返回新 iframe 但都挂同一 win。
 */
function makeSharedEnv(sharedWin?: FakeWindow): {
	env: EmbedWindowEnv;
	iframe: FakeIframe;
	win: FakeWindow;
} {
	const handlers = sharedWin?.handlers ?? [];
	const removed = sharedWin?.removed ?? [];
	const win: FakeWindow = sharedWin ?? {
		handlers,
		removed,
		addEventListener: (_t, h) => void handlers.push(h),
		removeEventListener: (_t, h) => {
			const i = handlers.indexOf(h);
			if (i >= 0) handlers.splice(i, 1);
		},
	};
	const iframeRemoved: boolean[] = [];
	const iframe: FakeIframe = {
		src: "",
		style: { width: "", height: "", border: "" },
		contentWindow: { postMessage: () => {} },
		// 推 iframe 自己的 `removed` 数组——多实例测试断言每个 iframe 各自的
		// 移除历史；`win.removed` 仅做"window 层有没有 remove 调用过"的兜底。
		remove: () => void iframeRemoved.push(true),
		setAttribute: () => {},
		posted: [],
		removed: iframeRemoved,
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
	 * M1 R7：两个独立 create() 必须互不影响；destroy(A) 之后 A 不再派发，
	 * 但 B 仍能正常接收消息。
	 *
	 * 关键修复：两个实例**必须共享同一 fake `window`**——真实宿主页面只有
	 * 一个 document/window，多实例共用同一 message 事件总线。旧版本各自
	 * 注入独立 fake win，等于在测两个完全隔离的世界，无法证明真实多实例
	 * 互不干扰。
	 *
	 * 验证点：
	 *   - 共用 win 上有 **2** 条 handler（不是各 1 条）；
	 *   - destroy(A) 只移除 A 注册的那条 handler，B 的仍保留；
	 *   - destroy(A) 后 B 仍能正常接收并派发事件。
	 */
	test("multi-instance: destroy(A) does not affect B (shared window)", () => {
		const { iframe: iframeA, win, env } = makeSharedEnv();
		const { iframe: iframeB } = makeSharedEnv(win);
		const readyA: Array<unknown> = [];
		const readyB: Array<unknown> = [];
		const instA = create({
			appId: APP,
			baseUrl: BASE,
			container: container() as unknown as HTMLElement,
			env: { ...env, createInternal: () => iframeA },
		});
		const instB = create({
			appId: APP,
			baseUrl: BASE,
			container: container() as unknown as HTMLElement,
			env: { ...env, createInternal: () => iframeB },
		});
		instA.on("ready", () => void readyA.push(undefined));
		instB.on("ready", () => void readyB.push(undefined));
		instA.open();
		instB.open();

		// **关键**：同一 window 上同时挂着 2 条 handler——证明它们真的共享总线。
		expect(win.handlers).toHaveLength(2);

		instA.destroy();
		expect(iframeA.removed).toEqual([true]);
		expect(iframeB.removed).toEqual([]); // B 仍未 destroy
		expect(win.handlers).toHaveLength(1); // 只移除 A 那条

		// B 仍能接收 ready 事件（payload 必须带 publicAppId + mode，协议强校验）。
		hostEvent(win, iframeB, {
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
	test("mount failure (appendChild throws) does not leak listener (R5) + instance is broken (R8)", () => {
		const { env, iframe, win } = makeEnv();
		const originalErr = new Error("detached parent");
		const boom = {
			appendChild: () => {
				throw originalErr;
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
		// R8: 抛 EmbedInstanceBrokenError（cause 链上挂原 err）。
		let caught: unknown;
		try {
			inst.open();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(EmbedInstanceBrokenError);
		expect((caught as { cause?: unknown }).cause).toBe(originalErr);
		// 关键断言 —— appendChild 抛错后，listener 列表保持空。
		expect(win.handlers).toHaveLength(0);
		// R8: iframe 引用被保留（让 destroy 仍能 remove），未挂上 document。
		// destroy() 不抛错，且 remove() 仍被调用。
		expect(() => inst.destroy()).not.toThrow();
		expect(iframe.removed).toEqual([true]);
		// iframe.posted 仍为空——没有 init 消息发出（mount 失败前 postInit 未跑）。
		expect(iframe.posted).toEqual([]);
	});

	test("init postMessage failure rolls back iframe and listener and leaves a broken instance", () => {
		const { env, iframe, win } = makeEnv();
		const originalErr = new Error("postMessage boom");
		(iframe.contentWindow as { postMessage: () => void }).postMessage = () => {
			throw originalErr;
		};
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			launchToken: "tok_signed",
			container: container() as unknown as HTMLElement,
			env,
		});
		let caught: unknown;
		try {
			inst.open();
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(EmbedInstanceBrokenError);
		expect((caught as { cause?: unknown }).cause).toBe(originalErr);
		expect(win.handlers).toHaveLength(0);
		expect(iframe.removed).toEqual([true]);
		expect(() => inst.open()).toThrow(EmbedInstanceBrokenError);
		expect(() => inst.logout()).toThrow(EmbedInstanceBrokenError);
		expect(() => inst.requestResize()).toThrow(EmbedInstanceBrokenError);
		expect(() => inst.destroy()).not.toThrow();
		expect(iframe.removed).toEqual([true]);
	});

	/**
	 * R8 阻断项 #3：mount 失败后**不可复用**——后续 `open()` 必须抛
	 * `EmbedInstanceBrokenError`，**禁止**降级为匿名 init（即不能再
	 * 发出 init postMessage）。这是 signed-user 实例"静默丢失身份"的
	 * 关键修复路径。
	 */
	test("R8: mount failure -> second open throws EmbedInstanceBrokenError (no anonymous fallback)", () => {
		const { env, iframe } = makeEnv();
		const boom = {
			appendChild: () => {
				throw new Error("detached parent");
			},
			children: [],
		};
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			launchToken: "tok_signed",
			container: boom as unknown as HTMLElement,
			env,
		});
		// 第一次 open：抛 EmbedInstanceBrokenError。
		expect(() => inst.open()).toThrow(EmbedInstanceBrokenError);
		// **关键**：iframe 没发出任何 init 消息（mount 失败前 postInit 未跑）。
		expect(iframe.posted).toEqual([]);
		// 第二次 open：必须仍抛 EmbedInstanceBrokenError，**不**降级为匿名。
		expect(() => inst.open()).toThrow(EmbedInstanceBrokenError);
		expect(iframe.posted).toEqual([]); // 仍然为空——没有匿名 init
	});

	/**
	 * R8 阻断项 #3：mount 失败后 `logout()` 抛 `EmbedInstanceBrokenError`，
	 * 避免向一个未挂上的 iframe 发 postMessage（更重要的：避免看起来
	 * 正常的 logout 掩盖 broken 态）。
	 */
	test("R8: mount failure -> logout throws EmbedInstanceBrokenError", () => {
		const { env, iframe } = makeEnv();
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			container: {
				appendChild: () => {
					throw new Error("detached parent");
				},
				children: [],
			} as unknown as HTMLElement,
			env,
		});
		expect(() => inst.open()).toThrow(EmbedInstanceBrokenError);
		expect(() => inst.logout()).toThrow(EmbedInstanceBrokenError);
		// 关键：没有任何 postMessage 发出。
		expect(iframe.posted).toEqual([]);
	});

	/**
	 * R8 阻断项 #3：mount 失败后 `requestResize()` 抛 `EmbedInstanceBrokenError`，
	 * 避免在 broken 态下"假装可调整尺寸"掩盖问题。
	 */
	test("R8: mount failure -> requestResize throws EmbedInstanceBrokenError", () => {
		const { env, iframe } = makeEnv();
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			container: {
				appendChild: () => {
					throw new Error("detached parent");
				},
				children: [],
			} as unknown as HTMLElement,
			env,
		});
		expect(() => inst.open()).toThrow(EmbedInstanceBrokenError);
		expect(() => inst.requestResize()).toThrow(EmbedInstanceBrokenError);
		expect(iframe.posted).toEqual([]);
	});

	/**
	 * R8 阻断项 #3：mount 失败后**不再派发事件**——`addEventListener` 之前
	 * 已确认不会被调用（mount 失败不注册 listener），这里验证 iframe
	 * 即使在 mount 失败后投递消息，宿主订阅者也收不到。
	 */
	test("R8: mount failure -> ready events are not dispatched (no listener registered)", () => {
		const { env, iframe, win } = makeEnv();
		const ready: Array<unknown> = [];
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			container: {
				appendChild: () => {
					throw new Error("detached parent");
				},
				children: [],
			} as unknown as HTMLElement,
			env,
		});
		inst.on("ready", () => void ready.push(undefined));
		expect(() => inst.open()).toThrow(EmbedInstanceBrokenError);
		// iframe 上线后投递 ready：因为 win 上根本没挂 handler，宿主不收。
		hostEvent(win, iframe, {
			protocol: "skdy-embed",
			version: EMBED_PROTOCOL_VERSION,
			type: "ready",
			payload: { publicAppId: APP, mode: "anonymous" },
		});
		expect(ready).toEqual([]);
	});
});
