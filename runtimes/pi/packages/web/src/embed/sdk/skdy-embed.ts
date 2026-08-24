/**
 * WB-010: host-side Enterprise Embed SDK.
 *
 * `create()` builds an `<iframe>` pointing at the hosted embed app, drives the
 * postMessage v1 protocol (anonymous or signed-user init), and surfaces host
 * lifecycle events (ready / error / conversation-created / resize). Security
 * posture vs. the "禁止/验收" gates:
 *
 *   - The SDK never touches the host's private keys; it only forwards a Launch
 *     Token the host backend already signed (signed-user mode).
 *   - `launchToken` is sent once into the iframe and is released from SDK
 *     memory immediately (never written to the URL or storage).
 *   - Incoming postMessage is validated against `event.source === el.contentWindow`,
 *     against an origin allowlist, and against the protocol/version envelope.
 *     Wrong source / wrong origin / wrong version events are ignored, never
 *     dispatched to host handlers.
 *   - `destroy()` removes the iframe and all message listeners (no leakage).
 *
 * The module is framework-agnostic and depends only on `DOMWindow`; tests inject
 * a fake `window` so it runs in Node.
 *
 * # SECURITY NOTES — Launch Token boundary (M1 R7)
 *
 * The Launch Token is the **only secret** that crosses the SDK boundary
 * (signed-user mode). The following invariants are non-negotiable:
 *
 * - **OUTBOUND (SDK's responsibility).** Every `iframe.contentWindow.postMessage`
 *   call goes through one of `postInit` / `logout` / `requestResize` (and the
 *   future `focus`). The token only ever appears in `init.payload.launchToken`,
 *   **once** — `postInit` snapshots it then immediately sets
 *   `pendingLaunchToken = undefined` before invoking `postMessage`, so even a
 *   hostile `contentWindow.postMessage` implementation cannot observe the
 *   variable after this point. The regression test
 *   `sdk-token-boundary.test.ts: outbound: no postMessage after init carries
 *   launchToken` asserts this for every outbound message type.
 *
 * - **INBOUND (iframe producer's responsibility).** `decodeEmbedIframeMessage`
 *   validates that `error.payload.message` is a string but does **not** scrub
 *   it. The SDK forwards iframe errors verbatim. The iframe producer MUST NOT
 *   embed `launchToken` / `externalUserId` / other secrets in `error.message`
 *   (spec 7.2). The SDK cannot enforce this — the boundary is the iframe
 *   producer, not the host SDK. This is asserted by the `passthrough` test
 *   in `sdk-token-boundary.test.ts`.
 *
 * - **Memory release.** `create()` immediately destructures `options` into
 *   closure-local consts; the **only** variable holding the token is
 *   `pendingLaunchToken` (a `let`). All release paths zero it out:
 *   - successful `init` postMessage (snapshot + zero, then call);
 *   - `mount()` early-return (`disposed` / `iframe !== null`);
 *   - `mount()` `appendChild` throws → token cleared before rethrow;
 *   - `logout()` → zeroed after postMessage;
 *   - `destroy()` → zeroed after listener cleanup.
 *
 * - **NOT in URL.** `iframe.src` only ever contains `${baseUrl}/embed/${appId}`
 *   — never the token. Constructed by `buildIframe()` (this file) using
 *   closure-local `baseUrl` / `appId`.
 * - **NOT in storage.** Never written to `localStorage` / `sessionStorage` /
 *   `document.cookie` / IndexedDB. The SDK is framework-agnostic and has no
 *   storage layer.
 * - **NOT in DOM.** Never assigned to any DOM attribute. `setAttribute` only
 *   receives `"title"` for a11y.
 *
 * # 代码级回归约束
 *
 * `create()` 顶部的 destructure **必须**保持完整——后续闭包不得引用
 * `options.*`（lint/grep 应能验证）。`pendingLaunchToken` 是**唯一**持有
 * token 的变量；新增任何读/写 token 的代码路径前，必须确认它以
 * `pendingLaunchToken = undefined` 收尾。
 */
import {
	decodeEmbedIframeMessage,
	type EmbedPostMessageEnvelope,
	POST_MESSAGE_PROTOCOL,
	POST_MESSAGE_VERSION,
} from "@earendil-works/pi-protocol";

export interface EmbedDomWindow {
	readonly addEventListener: (type: "message", handler: (event: MessageEventLike) => void) => void;
	readonly removeEventListener: (type: "message", handler: (event: MessageEventLike) => void) => void;
}

export interface MessageEventLike {
	readonly source: unknown;
	readonly origin: string;
	readonly data: unknown;
}

export interface EmbedWindowEnv {
	readonly window: EmbedDomWindow;
	/** Creates a detached iframe element (defaults to document.createElement). */
	readonly createInternal: (width: number, height: number) => EmbedIframe;
}

export interface EmbedIframe {
	src: string;
	readonly style: {
		width: string;
		height: string;
		border: string;
	};
	readonly contentWindow: { readonly postMessage: (message: EmbedPostMessageEnvelope, targetOrigin: string) => void };
	readonly remove: () => void;
	readonly setAttribute: (name: string, value: string) => void;
}

export interface EmbedHostEvents {
	/** iframe 就绪（匿名或 signed_user 初始化完成）。 */
	readonly ready: undefined;
	/** iframe 主动上报错误。 */
	readonly error: { readonly code: string; readonly message: string };
	/** iframe 内新建了会话（`conversation-created`）。 */
	readonly "conversation-created": { readonly conversationId: string };
	/** iframe 通过 `resize` 请求更新高度。 */
	readonly resize: { readonly height: number };
}

export type EmbedHostEventName = keyof EmbedHostEvents;

export interface CreateEmbedOptions {
	readonly appId: string;
	/** Host element to mount the iframe into. When absent, the SDK mounts into a
	 *  floating element it creates (floating mode). */
	readonly container?: HTMLElement;
	/** Embed app base URL, e.g. "https://agent.example.com". */
	readonly baseUrl: string;
	/** Signed-user mode: a host-backend-signed Launch Token (SDK releases it
	 *  from memory after sending). Anonymous mode omits it. */
	readonly launchToken?: string;
	/** Default inline iframe size (px). */
	readonly initWidth?: number;
	readonly initHeight?: number;
	/** Extra allowed origins for postMessage (beyond the base origin). */
	readonly extraOrigins?: readonly string[];
	readonly env?: EmbedWindowEnv;
}

/** idempotent `new Handlers` per instance. */
export interface EmbedInstance {
	/** (Re)open: (re)attach the iframe to the container and re-send init. */
	on: <K extends EmbedHostEventName>(name: K, handler: (payload: EmbedHostEvents[K]) => void) => void;
	open: () => void;
	close: () => void;
	/** Post `resize-request` to ask the iframe to (re)report its height. */
	requestResize: () => void;
	/** Telegraph host logout to the iframe (signed credentials cleared). */
	logout: () => void;
	/** Unmount the iframe and drop all listeners. */
	destroy: () => void;
}

/**
 * Create an embed instance. Throws on duplicate create on the same element or an
 * invalid `appId` / `baseUrl`.
 *
 * # 内存释放（launchToken）
 *
 * `options.launchToken` 是唯一的 secret。`create()` 入口**立即**把它从
 * `options` 拷出到 `pendingLaunchToken` 局部变量，并保证后续闭包**只引用
 * 局部变量**（不再持有 `options`）。
 *
 * 所有释放路径：
 *   - `postInit()` 发送 init postMessage 后 → `pendingLaunchToken = undefined`
 *     （成功路径）；
 *   - `postInit()` 提前 return（`iframe === null || disposed`）→ 不读 token；
 *   - `logout()` → `pendingLaunchToken = undefined`；
 *   - `destroy()` → `pendingLaunchToken = undefined`；
 *   - `mount()` 抛错（`appendChild` 失败）→ `pendingLaunchToken = undefined`。
 *
 * 代码级回归约束：禁止任何闭包引用 `options.*`；`options` 在函数顶部的校验
 * 完成后即可视为不可达——grep / lint 应能验证（详见 SECURITY NOTES）。
 */
export function create(options: CreateEmbedOptions): EmbedInstance {
	if (!/^pub_[0-9a-fA-F-]{36}$/.test(options.appId)) {
		throw new Error("appId must be a valid pub_<uuid> public app id");
	}
	if (options.baseUrl === "" || !/^https:\/\//.test(options.baseUrl)) {
		throw new Error("baseUrl must be an https URL");
	}

	// === Phase 1: 一次性 destructure，所有非敏感字段立即拷贝进 closure 局部 ===
	// 后续闭包**只能**引用这里的局部变量；不得再访问 `options.*`。
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const {
		// launchToken 是唯一 secret；单独持有。
		launchToken: optionsLaunchToken,
		// container 在 mount() 时仍要用；env 同样。
		container: optionsContainer,
		env: optionsEnv,
		// 以下字段在 phase 2 的 buildIframe 中使用，提取到局部闭包避免越界。
		baseUrl: optionsBaseUrl,
		appId: optionsAppId,
		initWidth: optionsInitWidth,
		initHeight: optionsInitHeight,
		extraOrigins: optionsExtraOrigins,
	} = options;
	// `options` 此后在本函数内**禁止**任何代码路径再读取——通过本注释 +
	// grep 拦截；闭包只能引用下面的局部 const。

	const env = optionsEnv ?? defaultEnv();
	const container = optionsContainer ?? null;
	const width = optionsInitWidth ?? 400;
	const height = optionsInitHeight ?? 600;
	const baseUrl = optionsBaseUrl;
	const appId = optionsAppId;
	const baseOrigin = originOf(baseUrl);
	const allowedOrigins = new Set([baseOrigin, ...(optionsExtraOrigins ?? [])]);

	let iframe: EmbedIframe | null = null;
	let disposed = false;
	/**
	 * Launch Token 单独持有。`let` 而非 `const` 是因为发送后必须把它清空；
	 * 任何路径都不再保留对原始 `options.launchToken` 的引用。
	 */
	let pendingLaunchToken: string | undefined = optionsLaunchToken;

	const handlers: Partial<Record<EmbedHostEventName, Array<(payload: never) => void>>> = {};

	const messageHandler = (event: MessageEventLike): void => {
		// W3C security gate #1: only accept frames from the iframe we spawned.
		if (event.source !== iframe?.contentWindow) return;
		// Gate #2: reject unexpected origins.
		if (event.origin === "" || !allowedOrigins.has(event.origin)) return;
		// Gate #3: protocol/version envelope validation.
		if (typeof event.data !== "object" || event.data === null) return;
		const raw = event.data as Record<string, unknown>;
		if (raw.protocol !== POST_MESSAGE_PROTOCOL || raw.version !== POST_MESSAGE_VERSION) return;
		const decoded = decodeEmbedIframeMessage(event.data);
		if (!decoded.ok) return;
		switch (decoded.message.type) {
			case "ready":
				emit("ready", undefined);
				break;
			case "error":
				emit("error", { code: decoded.message.code, message: decoded.message.message });
				break;
			case "conversation-created":
				emit("conversation-created", { conversationId: decoded.message.conversationId });
				break;
			case "resize":
				// Protocol decode is the single source of truth for resize validity
				// (range `1..POST_MESSAGE_RESIZE_MAX_HEIGHT`). Any rejection already
				// short-circuited via `if (!decoded.ok) return;` above.
				emit("resize", { height: decoded.message.height });
				syncHeight(decoded.message.height);
				break;
		}
	};

	const postInit = (): void => {
		if (iframe === null || disposed) {
			// dispose 或 mount 失败 → token 必须清空，避免泄漏。
			pendingLaunchToken = undefined;
			return;
		}
		const tokenSnapshot = pendingLaunchToken;
		// **释放时机**：postMessage 调用之前就把 token 视为已消费，立即清空。
		// 之后即便有人拦截 iframe.contentWindow.postMessage，也读不到 token。
		pendingLaunchToken = undefined;
		const message: EmbedPostMessageEnvelope =
			tokenSnapshot !== undefined
				? {
						protocol: POST_MESSAGE_PROTOCOL,
						version: POST_MESSAGE_VERSION,
						type: "init",
						payload: { launchToken: tokenSnapshot },
					}
				: { protocol: POST_MESSAGE_PROTOCOL, version: POST_MESSAGE_VERSION, type: "init" };
		iframe.contentWindow.postMessage(message, baseOrigin);
	};

	const buildIframe = (): EmbedIframe => {
		const el = env.createInternal(width, height);
		// src 只含 baseUrl + /embed/<appId>——使用闭包局部 `baseUrl`/`appId`，
		// 永不拼接 launchToken。
		el.src = `${baseUrl.replace(/\/+$/, "")}/embed/${appId}`;
		el.setAttribute("title", "Embedded assistant");
		return el;
	};

	const mount = (): void => {
		if (disposed) {
			pendingLaunchToken = undefined;
			return;
		}
		if (iframe !== null) return; // already mounted
		const built = buildIframe();
		// Append FIRST: if `container.appendChild` throws (detached document, CSP,
		// detached parent node in JSDOM), the iframe is *not* yet attached and
		// we must not register the message listener — otherwise the SDK would
		// leak a handler that never fires. This is the canonical
		// "register-after-commit" lifecycle pattern.
		try {
			if (container !== null) {
				container.appendChild(built as unknown as Node);
			} else {
				document.body.appendChild(built as unknown as Node);
			}
		} catch (err) {
			// mount 抛错路径：iframe 没挂上去 → 不持有引用 → token 立即清空。
			pendingLaunchToken = undefined;
			throw err;
		}
		// Commit iframe reference + listener only after a successful mount.
		iframe = built;
		env.window.addEventListener("message", messageHandler);
		postInit();
	};

	const unmount = (): void => {
		env.window.removeEventListener("message", messageHandler);
		if (iframe !== null) {
			iframe.remove();
			iframe = null;
		}
	};

	const syncHeight = (h: number): void => {
		if (iframe !== null) iframe.style.height = `${h}px`;
	};

	const emit = <K extends EmbedHostEventName>(name: K, payload: EmbedHostEvents[K]): void => {
		const list = handlers[name] as Array<(p: EmbedHostEvents[K]) => void> | undefined;
		if (list === undefined) return;
		for (const fn of list) fn(payload);
	};

	return {
		on(name, handler) {
			let list = handlers[name];
			if (list === undefined) {
				list = [];
				handlers[name] = list;
			}
			(list as Array<(p: never) => void>).push(handler as (p: never) => void);
		},
		open: mount,
		close: unmount,
		requestResize() {
			if (iframe === null || disposed) return;
			iframe.contentWindow.postMessage(
				{ protocol: POST_MESSAGE_PROTOCOL, version: POST_MESSAGE_VERSION, type: "resize-request" },
				baseOrigin,
			);
		},
		logout() {
			if (iframe === null || disposed) return;
			iframe.contentWindow.postMessage(
				{ protocol: POST_MESSAGE_PROTOCOL, version: POST_MESSAGE_VERSION, type: "logout" },
				baseOrigin,
			);
			// logout 后 token 一定释放——后续即便重新挂载也不再使用旧 token。
			pendingLaunchToken = undefined;
		},
		destroy() {
			if (disposed) return;
			disposed = true;
			unmount();
			pendingLaunchToken = undefined;
			for (const key of Object.keys(handlers) as EmbedHostEventName[]) handlers[key] = [];
		},
	};
}

function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return url;
	}
}

function defaultEnv(): EmbedWindowEnv {
	return {
		window: window,
		createInternal(width, height) {
			const el = document.createElement("iframe");
			el.width = String(width);
			el.height = String(height);
			el.style.width = `${width}px`;
			el.style.height = `${height}px`;
			el.style.border = "0";
			el.style.minHeight = "200px";
			return el as unknown as EmbedIframe;
		},
	};
}
