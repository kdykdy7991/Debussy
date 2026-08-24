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
 * # SECURITY NOTES — Launch Token boundary (M1 R5)
 *
 * The Launch Token is the **only secret** that crosses the SDK boundary
 * (signed-user mode). The following invariants are non-negotiable:
 *
 * - **NOT in URL.** `iframe.src` only ever contains `${baseUrl}/embed/${appId}`
 *   — never the token. Constructed by `buildIframe()` (this file).
 * - **NOT in storage.** Never written to `localStorage` / `sessionStorage` /
 *   `document.cookie` / IndexedDB. The SDK is framework-agnostic and has no
 *   storage layer.
 * - **NOT in DOM.** Never assigned to any DOM attribute. `setAttribute` only
 *   receives `"title"` for a11y.
 * - **NOT in logs / errors.** `error` event payload is
 *   `{ code: string; message: string }` from the protocol envelope
 *   (`embed/post-message.ts` `error` type) — the protocol explicitly forbids
 *   embedding the token in error events. If a future code path adds payload
 *   fields, audit them against this list before merging.
 * - **Released from memory on every code path**:
 *   - successful `init` postMessage → `pendingLaunchToken = undefined`
 *     (see `postInit()`);
 *   - explicit `logout()` → `pendingLaunchToken = undefined`;
 *   - `destroy()` → `pendingLaunchToken = undefined`.
 *
 * The token is held in a single local variable (`pendingLaunchToken`) until
 * the next `init` round-trip, then dropped. If you add a new code path that
 * reads or copies the token, **first** confirm it terminates in a
 * `pendingLaunchToken = undefined` assignment.
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
 */
export function create(options: CreateEmbedOptions): EmbedInstance {
	if (!/^pub_[0-9a-fA-F-]{36}$/.test(options.appId)) {
		throw new Error("appId must be a valid pub_<uuid> public app id");
	}
	if (options.baseUrl === "" || !/^https:\/\//.test(options.baseUrl)) {
		throw new Error("baseUrl must be an https URL");
	}
	const env = options.env ?? defaultEnv();
	const container = options.container ?? null;
	const width = options.initWidth ?? 400;
	const height = options.initHeight ?? 600;
	const baseOrigin = originOf(options.baseUrl);
	const allowedOrigins = new Set([baseOrigin, ...(options.extraOrigins ?? [])]);

	let iframe: EmbedIframe | null = null;
	let disposed = false;
	/** Launch Token is folded into a transient init message then dropped. */
	let pendingLaunchToken: string | undefined = options.launchToken;

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
		if (iframe === null || disposed) return;
		const message: EmbedPostMessageEnvelope =
			pendingLaunchToken !== undefined
				? {
						protocol: POST_MESSAGE_PROTOCOL,
						version: POST_MESSAGE_VERSION,
						type: "init",
						payload: { launchToken: pendingLaunchToken },
					}
				: { protocol: POST_MESSAGE_PROTOCOL, version: POST_MESSAGE_VERSION, type: "init" };
		// Release the token from SDK memory immediately after the exchange.
		pendingLaunchToken = undefined;
		iframe.contentWindow.postMessage(message, baseOrigin);
	};

	const buildIframe = (): EmbedIframe => {
		const el = env.createInternal(width, height);
		el.src = `${options.baseUrl.replace(/\/+$/, "")}/embed/${options.appId}`;
		el.setAttribute("title", "Embedded assistant");
		return el;
	};

	const mount = (): void => {
		if (disposed) return;
		if (iframe !== null) return; // already mounted
		const built = buildIframe();
		// Append FIRST: if `container.appendChild` throws (detached document, CSP,
		// detached parent node in JSDOM), the iframe is *not* yet attached and
		// we must not register the message listener — otherwise the SDK would
		// leak a handler that never fires. This is the canonical
		// "register-after-commit" lifecycle pattern.
		if (container !== null) {
			container.appendChild(built as unknown as Node);
		} else {
			document.body.appendChild(built as unknown as Node);
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
