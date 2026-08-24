/**
 * WB-010 / M1 R7: Launch Token boundary guard。
 *
 * 旧 R5 版本错误地把 "iframe error message 不含 token" 当作 SDK 测试。
 * 但 `decodeEmbedIframeMessage` 对 `error.payload.message` 只做 `typeof === "string"`
 * 校验（`post-message.ts:165`），**协议层不做字符串清洗**——SDK 是 iframe 错误
 * 的纯透传管道，无法阻止 iframe 侧把 token 拼进 message。
 *
 * 真正的防护层级如下：
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  iframe 生产端（server / R5 协议强约束）                          │
 *   │  ─ 拼装 `error.message` 时**不得**包含 `launchToken` /           │
 *   │    `externalUserId` 等 secret（spec 7.2 + post-message.ts 行 17） │
 *   └──────────────────────────────────────────────────────────────────┘
 *                 ↓ postMessage
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  SDK（host 端）                                                   │
 *   │  ─ 入站：`decodeEmbedIframeMessage` 解包 → 转发 `error` 事件给    │
 *   │    宿主订阅者，**不做字符串清洗**（iframe 背书的内容由 iframe     │
 *   │    负责）。                                                      │
 *   │  ─ 出站：`iframe.contentWindow.postMessage` 仅发 `init` /        │
 *   │    `logout` / `focus` / `resize-request`，**永不**把 token       │
 *   │    拼进任何字段。                                                │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * 因此本文件的真正回归约束是**出站路径**：SDK 在 `init` 之后清空
 * `pendingLaunchToken`，**所有**后续 `iframe.contentWindow.postMessage`
 * 调用都不携带 token（连 init 的 16 KiB 上限外的字段也不带）。
 *
 * 入站路径只验证 SDK 是 passthrough（不二次污染/二次泄漏），**不**验证
 * iframe 端是否合规——那是 iframe producer 的责任，不在 SDK 测试覆盖范围。
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

/**
 * R8 阻断项 #3: 构造一个在 `contentWindow.postMessage` 第 N 次调用时抛错的
 * fake iframe，验证 `logout()` 在 postMessage 异常下仍完成 token 释放。
 *
 * `throwOn` 指定从第几次调用开始抛错（1-indexed）：
 *   - `throwOn: 1` → 第一次 postMessage（init）就抛，验证即便 init 都失败，
 *     token 释放路径仍走完（postInit 先 snapshot 再清 pendingLaunchToken）。
 *   - `throwOn: 2` → init 已成功，logout 的 postMessage 抛错——验证
 *     `try/finally` 包裹 logout 时 token 必清。
 */
function makeEnvWithPostMessageError(throwOn: number): { env: EmbedWindowEnv; iframe: FakeIframe; win: FakeWindow } {
	const posted: EmbedPostMessageEnvelope[] = [];
	const handlers: Array<(event: MessageEventLike) => void> = [];
	const attributeWrites: Array<{ name: string; value: string }> = [];
	const iframe: FakeIframe = {
		src: "",
		style: { width: "", height: "", border: "" },
		contentWindow: {
			postMessage: (m) => {
				posted.push(m);
				if (posted.length === throwOn) {
					throw new Error("postMessage boom (simulated hostile iframe)");
				}
			},
		},
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

describe("Launch Token boundary (M1 R7)", () => {
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

	/**
	 * **真正的回归约束**（R7 修正）：SDK 任何出站 postMessage 都不得携带
	 * `launchToken`，**包括 init 之外的所有类型**（`logout` / `resize-request`
	 * / `focus`）。R7 重写 `create()` 之后 `pendingLaunchToken` 是单一可清空
	 * 变量，发完 init 后立即 `undefined`；后续闭包不得引用 `options.launchToken`。
	 *
	 * 旧 R5 版本用"iframe error.message 不含 token"——这根本不在 SDK 的保护
	 * 范围：`decodeEmbedIframeMessage` 对 `error.message` 只校验 `typeof ===
	 * "string"`，iframe 端若把 token 拼进 message，SDK 只能透传。本测试替换为
	 * 出站路径——SDK 自己发出的所有 postMessage 都不能"二次包装" token。
	 */
	test("outbound: no postMessage after init carries launchToken (any type)", () => {
		const { env, iframe } = makeEnv();
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			launchToken: SENTINEL,
			container: container() as unknown as HTMLElement,
			env,
		});
		inst.open();
		// init 已发过（payload.launchToken === SENTINEL）；触发其它出站消息。
		inst.logout();
		inst.requestResize();

		// 把 init 单独算——payload.launchToken 是**预期**的入口；其它类型必不含。
		const init = iframe.posted[0]!;
		expect(init.type).toBe("init");
		expect((init.payload as Record<string, unknown>).launchToken).toBe(SENTINEL);

		// logout / resize-request 的 JSON 序列化里**不得**出现 SENTINEL。
		const nonInit = iframe.posted.slice(1);
		expect(nonInit.length).toBeGreaterThanOrEqual(2);
		for (const m of nonInit) {
			expect(JSON.stringify(m)).not.toContain(SENTINEL);
		}
		// 也断言 logout / resize-request 是已知类型（防止被改成任意 wrapper）。
		expect(nonInit.map((m) => m.type)).toEqual(["logout", "resize-request"]);
	});

	/**
	 * SDK 是 iframe 错误的纯透传（passthrough）。本测试**故意**注入含 SENTINEL
	 * 的恶意 / 有 bug 的 iframe error，验证：
	 *
	 *   1. SDK 不做字符串清洗——宿主订阅者**确实**收到 SENTINEL（iframe
	 *      producer 的责任，SDK 不背锅也不二次污染）；
	 *   2. **但** SDK 的 `iframe.contentWindow.postMessage` 出站全集不含
	 *      SENTINEL（防止 SDK 自己在某次回调里把 token 拼回去发出去）。
	 *
	 * 旧 R5 "error message 不含 token" 测试是无效证明（payload 本来就不含
	 * token）。本测试在 message 里**故意**嵌入 SENTINEL——如果 SDK 真做了清
	 * 洗或屏蔽，这条断言会失败。
	 */
	test("passthrough: SDK forwards iframe error verbatim, but never echoes token outbound", () => {
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

		// 故意注入含 SENTINEL 的 iframe error——模拟有 bug 或恶意 iframe。
		for (const h of [...win.handlers]) {
			h({
				source: iframe.contentWindow,
				origin: BASE,
				data: {
					protocol: "skdy-embed",
					version: EMBED_PROTOCOL_VERSION,
					type: "error",
					payload: { code: "INTERNAL_ERROR", message: `diag context: launchToken=${SENTINEL}` },
				},
			});
		}

		// 1. 透传：宿主订阅者收到的 message 含 SENTINEL。
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain(SENTINEL);
		expect(errors[0]?.code).toBe("INTERNAL_ERROR");

		// 2. 出站路径没有把 token 二次发出去（init 之外）。
		const initOnly = iframe.posted.filter((m) => m.type === "init");
		const nonInit = iframe.posted.filter((m) => m.type !== "init");
		expect(initOnly.length).toBe(1);
		expect(initOnly[0]?.payload).toEqual({ launchToken: SENTINEL });
		for (const m of nonInit) {
			expect(JSON.stringify(m)).not.toContain(SENTINEL);
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

	/**
	 * R8 阻断项 #3：logout 的 `contentWindow.postMessage` 抛错时（cross-origin /
	 * closed window / hostile iframe），token 释放仍完成。R7 之前的实现是
	 * "postMessage → pendingLaunchToken = undefined"——postMessage 抛错则
	 * 清理不执行，token 残留到 destroy()。R8 改为 `try/finally`。
	 *
	 * 间接验证：再 `inst.open()` 不能从 init payload 里看到 SENTINEL。
	 */
	test("R8: logout postMessage throws -> token release still completes", () => {
		// throwOn: 2 → init(1) 成功，logout(2) 的 postMessage 抛错。
		const { env, iframe } = makeEnvWithPostMessageError(2);
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			launchToken: SENTINEL,
			container: container() as unknown as HTMLElement,
			env,
		});
		inst.open();
		// init(1) 已成功发出（payload.launchToken === SENTINEL 是预期入口）。
		expect(iframe.posted).toHaveLength(1);
		expect(iframe.posted[0]?.type).toBe("init");
		expect((iframe.posted[0]?.payload as Record<string, unknown>).launchToken).toBe(SENTINEL);

		// logout 触发 postMessage(2) 抛错；try/finally 保证 token 释放完成
		// （错误会**原样上抛**给调用方——try/finally 不吞错，这是 JS 语义；
		// 关键在于 finally 一定跑了，即 token 一定清空）。
		expect(() => inst.logout()).toThrow(/postMessage boom/);
		// 但 iframe 仍记录了 logout 消息（push 发生在 throw 之前）。
		expect(iframe.posted).toHaveLength(2);
		expect(iframe.posted[1]?.type).toBe("logout");

		// **关键**：token 释放仍完成。再次 open 走 init 路径：payload 不带 SENTINEL。
		// close() 让 iframe 重新设为 null，open() 重新挂上；这里直接验证 SENTINEL
		// 不出现在第二次 init 的 payload 中（这正是 R7 修复点的扩展：R7 验证
		// "init 后所有出站不带 token"，R8 额外验证 "logout 异常也不带 token"）。
		inst.close();
		inst.open();
		const allNonInit = iframe.posted.filter((m) => m.type !== "init");
		for (const m of allNonInit) {
			expect(JSON.stringify(m)).not.toContain(SENTINEL);
		}
		const inits = iframe.posted.filter((m) => m.type === "init");
		expect(inits).toHaveLength(2);
		// 第二次 init 必为匿名（pendingLaunchToken 已被 finally 清空）：
		// payload 要么是 undefined（无 launchToken 字段），要么 launchToken 是 undefined。
		const secondPayload = inits[1]?.payload as Record<string, unknown> | undefined;
		const secondToken = secondPayload !== undefined ? (secondPayload.launchToken as string | undefined) : undefined;
		expect(secondToken).toBeUndefined();
		// 直接断言 SENTINEL 不在第二次 init 的 JSON 里。
		expect(JSON.stringify(inits[1])).not.toContain(SENTINEL);
	});

	/**
	 * R8 阻断项 #3：init 阶段 postMessage 就抛错时（hostile iframe 立刻拒绝
	 * init 消息），postInit 的 snapshot + 立即清空 `pendingLaunchToken` 仍生效。
	 * 后续 `logout` / 任何出站消息都不应再出现 SENTINEL。
	 */
	test("R8: init postMessage throws -> token still cleared before throw propagates", () => {
		// throwOn: 1 → init 本身抛错。
		const { env, iframe } = makeEnvWithPostMessageError(1);
		const inst = create({
			appId: APP,
			baseUrl: BASE,
			launchToken: SENTINEL,
			container: container() as unknown as HTMLElement,
			env,
		});
		// init 抛错会把实例置为 broken 并保留原始 cause；token 同时清空。
		expect(() => inst.open()).toThrow(/mount failed during listener registration or init/);
		// init 已被 push（push 在 throw 之前），但 payload.launchToken
		// 不在后续任何出站消息里出现。
		expect(iframe.posted).toHaveLength(1);
		expect(iframe.posted[0]?.type).toBe("init");
		expect((iframe.posted[0]?.payload as Record<string, unknown>).launchToken).toBe(SENTINEL);

		// broken 实例禁止后续出站，不能匿名降级。
		expect(() => inst.logout()).toThrow(/broken instance/);
		expect(() => inst.requestResize()).toThrow(/broken instance/);
		const allNonInit = iframe.posted.filter((m) => m.type !== "init");
		for (const m of allNonInit) {
			expect(JSON.stringify(m)).not.toContain(SENTINEL);
		}
	});
});
