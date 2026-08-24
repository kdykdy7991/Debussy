/**
 * M0 Embed SDK 行为原型测试（WB-010 范围）。
 *
 * 覆盖：
 *   - mount / destroy 幂等
 *   - 多实例监听器隔离与清理（共享同一个宿主 window）
 *   - source / origin / version / 协议 / 类型校验
 *   - resize 非法值（含 NaN、负数、零、超过上限、上限附近）与最大高度裁剪
 *   - launchToken 不进入 localStorage / sessionStorage / cookie
 *
 * `height == 0` 的边界拒绝由 protocol decoder 单独负责（参见
 * packages/protocol/test/embed/post-message.test.ts 中 `decodeEmbedIframeMessage resize
 * boundary (A6)`）。本测试仅断言 SDK 信任协议层单一来源后
 * iframe.style.height 的同步结果。
 *
 * 测试基础设施与现有 `sdk.test.ts` 一致：注入 fake `window` / `iframe`，跑在
 * vitest node 环境，不引入新依赖。
 */

import { EMBED_PROTOCOL_VERSION, type EmbedPostMessageEnvelope } from "@earendil-works/pi-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
	/**
	 * 调用 `iframe.remove()` 的次数（每次 push `true`）。fake 测试用——实际
	 * 生产 `EmbedIframe` 只暴露 `remove()` 不暴露此计数器。去掉 `readonly` 让
	 * `removed.push(true)` 在闭包里正常赋值（之前 readonly 与 push 冲突会
	 * 让 typecheck 拒绝，挂在 TS2540）。
	 */
	removed: boolean[];
}

interface FakeWindow extends EmbedDomWindow {
	/**
	 * 注册到 fake window 的 message handler 列表。`readonly` 与
	 * `handlers.push(h)` 并不冲突（push 不重新赋值），保留语义。
	 */
	readonly handlers: Array<(event: MessageEventLike) => void>;
	/**
	 * 调用 `removeEventListener` 的次数（每次 push `true`）。fake 测试用，
	 * 非 readonly 以允许闭包内 push。
	 */
	removed: boolean[];
	/**
	 * 调用 `addEventListener` 的次数（`+= 1` 累加）。fake 测试用，非 readonly
	 * 以允许 `win.added += 1`。
	 */
	added: number;
}

interface FakeEnv extends EmbedWindowEnv {
	readonly iframe: FakeIframe;
	readonly win: FakeWindow;
}

function makeIframe(): FakeIframe {
	const posted: EmbedPostMessageEnvelope[] = [];
	const removed: boolean[] = [];
	return {
		src: "",
		style: { width: "", height: "", border: "" },
		contentWindow: { postMessage: (m) => void posted.push(m) },
		remove: () => void removed.push(true),
		setAttribute: () => {},
		posted,
		removed,
	};
}

function makeWindow(): FakeWindow {
	const handlers: Array<(event: MessageEventLike) => void> = [];
	const removed: boolean[] = [];
	const win: FakeWindow = {
		handlers,
		removed,
		added: 0,
		addEventListener: (_t, h) => {
			handlers.push(h);
			win.added += 1;
		},
		removeEventListener: (_t, h) => {
			const i = handlers.indexOf(h);
			if (i >= 0) handlers.splice(i, 1);
			removed.push(true);
		},
	};
	return win;
}

/** 单实例测试环境：每个 create() 拿到独立的 window + iframe。 */
function makeEnv(): FakeEnv {
	const win = makeWindow();
	const iframe = makeIframe();
	const env: FakeEnv = {
		window: win,
		createInternal: () => iframe,
		iframe,
		win,
	};
	return env;
}

/**
 * 多实例测试环境：所有 create() 共享同一 window，但每个 create() 拿到独立的
 * iframe；这样断言的是"宿主页面挂载多个 SDK 时监听器与事件流的隔离"。
 */
function makeSharedEnv(iframeCount: number): { envs: FakeEnv[]; sharedWin: FakeWindow } {
	const sharedWin = makeWindow();
	const envs: FakeEnv[] = [];
	for (let i = 0; i < iframeCount; i += 1) {
		const iframe = makeIframe();
		envs.push({
			window: sharedWin,
			createInternal: () => iframe,
			iframe,
			win: sharedWin,
		});
	}
	return { envs, sharedWin };
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
	vi.unstubAllGlobals();
});

describe("M0 prototype: mount / destroy 幂等", () => {
	it("destroy() 重复调用不抛错且仅首次生效", () => {
		const env = makeEnv();
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.open();
		expect(env.iframe.removed).toEqual([]);
		inst.destroy();
		expect(env.iframe.removed).toEqual([true]);
		expect(() => inst.destroy()).not.toThrow();
		// 第二次 destroy 不能摘除新 iframe
		expect(env.iframe.removed).toEqual([true]);
	});

	it("open() 重复调用只创建一个 iframe", () => {
		const env = makeEnv();
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.open();
		const initCountAfterFirst = env.iframe.posted.length;
		inst.open();
		inst.open();
		expect(env.iframe.posted.length).toBe(initCountAfterFirst);
	});

	it("destroy() 之后再 open() 不重建 iframe（disposed 终态）", () => {
		const env = makeEnv();
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.open();
		inst.destroy();
		const postedBefore = env.iframe.posted.length;
		const removedBefore = env.iframe.removed.length;
		inst.open();
		expect(env.iframe.posted.length).toBe(postedBefore);
		expect(env.iframe.removed.length).toBe(removedBefore);
	});

	it("destroy() 未 open() 时也能干净移除监听器", () => {
		const env = makeEnv();
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		// 未 open()，不调用 addEventListener
		inst.destroy();
		expect(env.win.handlers).toHaveLength(0);
		expect(env.iframe.removed).toEqual([]);
	});

	it("destroy() 后 requestResize / logout / on() 全部静默", () => {
		const env = makeEnv();
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.on("resize", () => {});
		inst.open();
		inst.destroy();
		const postedAfterDestroy = env.iframe.posted.length;
		inst.requestResize();
		inst.logout();
		inst.on("resize", () => {});
		expect(env.iframe.posted.length).toBe(postedAfterDestroy);
	});
});

describe("M0 prototype: 多实例监听器隔离（共享同一宿主 window）", () => {
	it("两个实例共享同一 window 时互不串扰", () => {
		const { envs, sharedWin } = makeSharedEnv(2);
		const [envA, envB] = envs as [FakeEnv, FakeEnv];
		const a = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env: envA });
		const b = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env: envB });
		const aResize: number[] = [];
		const bResize: number[] = [];
		a.on("resize", (p) => void aResize.push(p.height));
		b.on("resize", (p) => void bResize.push(p.height));
		a.open();
		b.open();
		expect(sharedWin.handlers).toHaveLength(2);

		// A 的 iframe 上报 resize → 只触发 A
		hostEvent(sharedWin, envA.iframe, {
			protocol: "skdy-embed",
			version: EMBED_PROTOCOL_VERSION,
			type: "resize",
			payload: { height: 100 },
		});
		expect(aResize).toEqual([100]);
		expect(bResize).toEqual([]);
	});

	it("A.destroy() 之后只剩 B 的监听器；B 仍能收到事件", () => {
		const { envs, sharedWin } = makeSharedEnv(2);
		const [envA, envB] = envs as [FakeEnv, FakeEnv];
		const a = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env: envA });
		const b = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env: envB });
		const aResize: number[] = [];
		const bResize: number[] = [];
		a.on("resize", (p) => void aResize.push(p.height));
		b.on("resize", (p) => void bResize.push(p.height));
		a.open();
		b.open();
		expect(sharedWin.handlers).toHaveLength(2);

		a.destroy();
		expect(sharedWin.handlers).toHaveLength(1);

		// A 已销毁；只向 B 的 iframe 发事件
		hostEvent(sharedWin, envB.iframe, {
			protocol: "skdy-embed",
			version: EMBED_PROTOCOL_VERSION,
			type: "resize",
			payload: { height: 222 },
		});
		expect(bResize).toEqual([222]);
		expect(aResize).toEqual([]);
	});

	it("resize 事件从 B 触发时 A 不响应（验证 source 绑定到具体 iframe）", () => {
		const { envs, sharedWin } = makeSharedEnv(2);
		const [envA, envB] = envs as [FakeEnv, FakeEnv];
		const a = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env: envA });
		const b = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env: envB });
		const aResize: number[] = [];
		const bResize: number[] = [];
		a.on("resize", (p) => void aResize.push(p.height));
		b.on("resize", (p) => void bResize.push(p.height));
		a.open();
		b.open();

		hostEvent(sharedWin, envB.iframe, {
			protocol: "skdy-embed",
			version: EMBED_PROTOCOL_VERSION,
			type: "resize",
			payload: { height: 333 },
		});
		expect(bResize).toEqual([333]);
		expect(aResize).toEqual([]);
	});

	it("每个实例独立维护 posted / removed；A.destroy 不影响 B 的 posted 计数", () => {
		const { envs, sharedWin } = makeSharedEnv(2);
		const [envA, envB] = envs as [FakeEnv, FakeEnv];
		const a = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env: envA });
		const b = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env: envB });
		a.open();
		b.open();
		expect(envA.iframe.posted).toHaveLength(1);
		expect(envB.iframe.posted).toHaveLength(1);
		expect(envA.iframe.removed).toHaveLength(0);
		expect(envB.iframe.removed).toHaveLength(0);

		a.destroy();
		expect(envA.iframe.removed).toEqual([true]);
		expect(envB.iframe.removed).toHaveLength(0);
		// 共享 window 移除监听器计数：原本 2，destroy 一次 -1
		expect(sharedWin.handlers).toHaveLength(1);
		expect(sharedWin.removed).toHaveLength(1);
	});
});

describe("M0 prototype: source / origin / version / envelope 校验", () => {
	function goodReady() {
		return {
			protocol: "skdy-embed",
			version: EMBED_PROTOCOL_VERSION,
			type: "ready",
			payload: { publicAppId: APP, mode: "anonymous" as const },
		};
	}

	it("event.source 不等于 iframe.contentWindow → 拒绝", () => {
		const env = makeEnv();
		const ready: unknown[] = [];
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.on("ready", () => void ready.push(true));
		inst.open();
		// 直接派发事件以避免 hostEvent 的 `??` 回退；null 与伪 source 都应被拦。
		const evt = (source: unknown): void => {
			for (const h of [...env.win.handlers]) h({ source, origin: BASE, data: goodReady() });
		};
		evt({ fake: "window" });
		evt(null);
		expect(ready).toHaveLength(0);
	});

	it("event.data 非对象 / null / 数组 → 拒绝", () => {
		const env = makeEnv();
		const errors: unknown[] = [];
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.on("error", (p) => void errors.push(p));
		inst.open();
		hostEvent(env.win, env.iframe, "string-payload");
		hostEvent(env.win, env.iframe, null);
		hostEvent(env.win, env.iframe, [1, 2, 3]);
		expect(errors).toHaveLength(0);
	});

	it("protocol / version / type 任意错误 → 拒绝", () => {
		const env = makeEnv();
		const ready: unknown[] = [];
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.on("ready", () => void ready.push(true));
		inst.open();
		hostEvent(env.win, env.iframe, { ...goodReady(), protocol: "skdy-embedX" });
		hostEvent(env.win, env.iframe, { ...goodReady(), protocol: "" });
		hostEvent(env.win, env.iframe, { ...goodReady(), version: EMBED_PROTOCOL_VERSION + 1 });
		hostEvent(env.win, env.iframe, { ...goodReady(), version: "1" });
		hostEvent(env.win, env.iframe, { ...goodReady(), type: "Ready" }); // 大小写敏感
		hostEvent(env.win, env.iframe, { ...goodReady(), type: "" });
		hostEvent(env.win, env.iframe, { ...goodReady(), type: 123 });
		expect(ready).toHaveLength(0);
	});

	it("origin 不在白名单 / 空字符串 → 拒绝且 targetOrigin 不更新", () => {
		const env = makeEnv();
		const ready: unknown[] = [];
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.on("ready", () => void ready.push(true));
		inst.open();
		hostEvent(env.win, env.iframe, goodReady(), { origin: "https://attacker.example" });
		hostEvent(env.win, env.iframe, goodReady(), { origin: "" });
		expect(ready).toHaveLength(0);
		// 即便后续 origin 改成 base，也不应回放旧事件（已无 targetOrigin 副作用）
		hostEvent(env.win, env.iframe, goodReady(), { origin: BASE });
		expect(ready).toHaveLength(1);
	});

	it("extraOrigins 列入白名单后允许", () => {
		const env = makeEnv();
		const ready: unknown[] = [];
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			extraOrigins: ["https://mirror.example"],
			container: container() as unknown as HTMLElement,
			env,
		});
		inst.on("ready", () => void ready.push(true));
		inst.open();
		hostEvent(env.win, env.iframe, goodReady(), { origin: "https://mirror.example" });
		expect(ready).toHaveLength(1);
	});
});

describe("M0 prototype: resize 非法值与上限", () => {
	function resizeMsg(height: unknown) {
		return {
			protocol: "skdy-embed",
			version: EMBED_PROTOCOL_VERSION,
			type: "resize",
			payload: { height },
		};
	}

	it("height 超过上限 (100000) → 拒绝", () => {
		const env = makeEnv();
		const resized: number[] = [];
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.on("resize", (p) => void resized.push(p.height));
		inst.open();
		hostEvent(env.win, env.iframe, resizeMsg(100001));
		hostEvent(env.win, env.iframe, resizeMsg(1e9));
		hostEvent(env.win, env.iframe, resizeMsg(Number.POSITIVE_INFINITY));
		expect(resized).toHaveLength(0);
	});

	it("height == 上限 (100000) → 接受", () => {
		const env = makeEnv();
		const resized: number[] = [];
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.on("resize", (p) => void resized.push(p.height));
		inst.open();
		hostEvent(env.win, env.iframe, resizeMsg(100000));
		expect(resized).toEqual([100000]);
	});

	// 当前实现缺口：未拦截 NaN / 负数 / 0 / 非整数 / 非数字高度。M0 原型断言目标行为，
	// 这些用例会失败，作为"当前实现缺口"的硬证据；修正待总架构师拍板后再单独提交。
	it("height == NaN → 应被拒绝", () => {
		const env = makeEnv();
		const resized: number[] = [];
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.on("resize", (p) => void resized.push(p.height));
		inst.open();
		hostEvent(env.win, env.iframe, resizeMsg(Number.NaN));
		expect(resized).toEqual([]);
	});

	it("height == -1 → 应被拒绝", () => {
		const env = makeEnv();
		const resized: number[] = [];
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.on("resize", (p) => void resized.push(p.height));
		inst.open();
		hostEvent(env.win, env.iframe, resizeMsg(-1));
		expect(resized).toEqual([]);
	});

	// resize == 0 已修复：协议层 `height < 0` → `height <= 0`；
	// SDK 层 messageHandler 同时增加 `<= 0` 拒绝（纵深防御）。
	it("height == 0 → 应被拒绝", () => {
		const env = makeEnv();
		const resized: number[] = [];
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.on("resize", (p) => void resized.push(p.height));
		inst.open();
		hostEvent(env.win, env.iframe, resizeMsg(0));
		expect(resized).toEqual([]);
	});

	it("height 是字符串 / null → 应被拒绝", () => {
		const env = makeEnv();
		const resized: unknown[] = [];
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.on("resize", (p) => void resized.push(p));
		inst.open();
		hostEvent(env.win, env.iframe, resizeMsg("321"));
		hostEvent(env.win, env.iframe, resizeMsg(null));
		expect(resized).toEqual([]);
	});

	it("height 上限之内的合法值仍同步到 iframe 样式", () => {
		const env = makeEnv();
		const inst = create({ appId: APP, baseUrl: BASE, container: container() as unknown as HTMLElement, env });
		inst.open();
		hostEvent(env.win, env.iframe, resizeMsg(456));
		expect(env.iframe.style.height).toBe("456px");
	});
});

describe("M0 prototype: launchToken 不进入 localStorage / sessionStorage / cookie", () => {
	const SENTINEL = "tok_live_must_never_be_persisted_5e8b";

	interface StorageSpy {
		setItem: ReturnType<typeof vi.fn>;
		getItem: ReturnType<typeof vi.fn>;
		removeItem: ReturnType<typeof vi.fn>;
		clear: ReturnType<typeof vi.fn>;
		key: ReturnType<typeof vi.fn>;
		length: number;
	}

	function makeStorageSpy(): StorageSpy {
		const map = new Map<string, string>();
		return {
			setItem: vi.fn((k: string, v: string) => void map.set(k, v)),
			getItem: vi.fn((k: string) => map.get(k) ?? null),
			removeItem: vi.fn((k: string) => void map.delete(k)),
			clear: vi.fn(() => map.clear()),
			key: vi.fn((i: number) => Array.from(map.keys())[i] ?? null),
			get length() {
				return map.size;
			},
		};
	}

	beforeEach(() => {
		const local = makeStorageSpy();
		const session = makeStorageSpy();
		vi.stubGlobal("localStorage", local);
		vi.stubGlobal("sessionStorage", session);
	});

	it("open() / close() / destroy() 全程不调用 localStorage.setItem", () => {
		const env = makeEnv();
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			launchToken: SENTINEL,
			container: container() as unknown as HTMLElement,
			env,
		});
		inst.open();
		inst.close();
		inst.open();
		inst.destroy();
		const ls = globalThis.localStorage as unknown as StorageSpy;
		expect(ls.setItem).not.toHaveBeenCalled();
		// 进一步断言：所有 setItem 调用中都不含 sentinel
		for (const call of ls.setItem.mock.calls) {
			expect(JSON.stringify(call)).not.toContain(SENTINEL);
		}
	});

	it("open() / close() / destroy() 全程不调用 sessionStorage.setItem", () => {
		const env = makeEnv();
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			launchToken: SENTINEL,
			container: container() as unknown as HTMLElement,
			env,
		});
		inst.open();
		inst.close();
		inst.open();
		inst.destroy();
		const ss = globalThis.sessionStorage as unknown as StorageSpy;
		expect(ss.setItem).not.toHaveBeenCalled();
		for (const call of ss.setItem.mock.calls) {
			expect(JSON.stringify(call)).not.toContain(SENTINEL);
		}
	});

	it("open() / close() / destroy() 全程不触发 document.cookie 写入", () => {
		// vitest 默认 node 环境没有 document；用 defineProperty 在 globalThis 上挂一个可监听 cookie 的对象
		let cookieValue = "";
		const cookieSpy = vi.fn((v: string) => {
			cookieValue = v;
		});
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: {
				get cookie() {
					return cookieValue;
				},
				set cookie(v: string) {
					cookieSpy(v);
				},
			},
		});
		try {
			const env = makeEnv();
			const inst = create({
				appId: APP,
				baseUrl: BASE,
				launchToken: SENTINEL,
				container: container() as unknown as HTMLElement,
				env,
			});
			inst.open();
			inst.close();
			inst.open();
			inst.destroy();
			expect(cookieSpy).not.toHaveBeenCalled();
			for (const call of cookieSpy.mock.calls) {
				expect(JSON.stringify(call)).not.toContain(SENTINEL);
			}
		} finally {
			delete (globalThis as { document?: unknown }).document;
		}
	});

	it("create() / destroy() 之后 Launch Token 在内存中也被释放", () => {
		const env = makeEnv();
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			launchToken: SENTINEL,
			container: container() as unknown as HTMLElement,
			env,
		});
		inst.open(); // init 应携带 token
		expect(env.iframe.posted[0]?.payload).toMatchObject({ launchToken: SENTINEL });
		// close → open 后不应再携带 token（这是已有契约）
		inst.close();
		inst.open();
		expect(env.iframe.posted.at(-1)?.payload).toBeUndefined();
		// destroy 之后任何 reopen 都不应再携带
		inst.destroy();
		inst.open();
		expect(env.iframe.posted.at(-1)?.payload).toBeUndefined();
	});
});
