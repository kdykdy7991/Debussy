import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig, type PluginOption } from "vite";

/**
 * `PI_WEB_TARGET` 控制本入口的产物裁剪：
 *
 * - 未设置 / "all"：双入口 build，admin 与 embed 各自独立 chunk
 * - "admin"：只 build admin 入口
 * - "embed"：只 build embed 入口
 *
 * dev server 也跟随：embed only dev 时，浏览器直接访问 `/` 也会被重写到
 * `embed.html`；admin dev 时，`/embed/:publicAppId` 重写到 `embed.html`。
 * 端口：admin=5173, embed=5174，便于并行调试。
 */
const target = process.env.PI_WEB_TARGET ?? "all";
const isAdminOnly = target === "admin";
const isEmbedOnly = target === "embed";
const isSingle = isAdminOnly || isEmbedOnly;

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * 读取 dev 模式的 admin token。dev:admin 脚本通过 `PI_CONTROL_ADMIN_TOKEN_FILE`
 * 把生成的 token 路径传给 vite，我们在这里一次性读入并在代理转发时自动写入
 * `Authorization: Bearer <token>` 头 —— 控制台前端从此不需要也不允许用户输入。
 *
 * 只在文件存在且非空时启用；缺失时不报错（与之前"无 token 全部 404"保持一致）。
 */
function loadDevAdminToken(): string | null {
	const file = process.env.PI_CONTROL_ADMIN_TOKEN_FILE;
	if (file === undefined || file === "") return null;
	if (!existsSync(file)) return null;
	const value = readFileSync(file, "utf8").trim();
	return value === "" ? null : value;
}
const devAdminToken = loadDevAdminToken();

function routeRewritePlugin(): PluginOption {
	return {
		name: "pi-web-route-rewrite",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use((req, _res, next) => {
				const url = req.url ?? "/";
				// Backend / Vite internal traffic must never fall through to the
				// SPA history fallback below — otherwise /api/control/*, WebSocket
				// upgrades, and HMR requests all collapse into index.html (MVP-01).
				if (
					url.startsWith("/api/") ||
					url.startsWith("/__vite") ||
					url.startsWith("/@") ||
					url.startsWith("/src/") ||
					url.startsWith("/node_modules/") ||
					url.startsWith("/ws")
				) {
					next();
					return;
				}
				if (isEmbedOnly) {
					if (url === "/" || url === "" || url === "/index.html") {
						req.url = "/embed.html";
					} else if (url.startsWith("/embed/") || url.startsWith("/preview/")) {
						req.url = "/embed.html";
					}
					next();
					return;
				}
				if (isAdminOnly) {
					if (url === "/embed.html" || url.startsWith("/embed/")) {
						req.url = "/404.html";
						_res.statusCode = 404;
					}
					next();
					return;
				}
				// Default (all / admin) dev mode: rewrite embed path to embed.html,
				// and let admin SPA paths fall back to admin index.html.
				if (/^\/(?:embed|preview)\/pub_[0-9a-fA-F-]{36}(\/|$|\?)/.test(url)) {
					req.url = "/embed.html";
					next();
					return;
				}
				// Admin SPA history fallback for paths that aren't real static files.
				if (
					req.method === "GET" &&
					!url.startsWith("/@") &&
					!url.startsWith("/src/") &&
					!url.startsWith("/node_modules/") &&
					!/^[^?]*\.[^/?]+(?:$|\?)/.test(url)
				) {
					req.url = "/index.html";
				}
				next();
			});
		},
	};
}

const adminInput = resolve(projectRoot, "index.html");
const embedInput = resolve(projectRoot, "embed.html");

export default defineConfig({
	appType: "mpa",
	plugins: [react(), routeRewritePlugin()],
	resolve: {
		alias: {
			"@earendil-works/pi-client": fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
			"@earendil-works/pi-protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
		},
	},
	server: {
		host: "127.0.0.1",
		port: isEmbedOnly ? 5174 : 5173,
		strictPort: true,
		proxy: buildProxyConfig(process.env.PI_EMBED_DEV_PROXY_TARGET, process.env.PI_ADMIN_DEV_PROXY_TARGET),
	},
	build: {
		rollupOptions: {
			input: isAdminOnly
				? { admin: adminInput }
				: isEmbedOnly
					? { embed: embedInput }
					: { admin: adminInput, embed: embedInput },
			output: {
				entryFileNames: (chunkInfo) => {
					const name = (chunkInfo as { name?: string }).name ?? "chunk";
					return `${name}/[name].js`;
				},
				chunkFileNames: isSingle ? "[name]-[hash].js" : "shared/[name]-[hash].js",
				assetFileNames: isSingle ? "[name]-[hash][extname]" : "shared/[name]-[hash][extname]",
			},
		},
	},
});

/**
 * Build the dev-server proxy config.
 *
 * The proxy forwards `/api/control` and `/api/embed` to the loopback control
 * server. Embed-mode uses `PI_EMBED_DEV_PROXY_TARGET`; admin-only mode uses
 * `PI_ADMIN_DEV_PROXY_TARGET` (the workbench's normal target). When the
 * expected env var is missing we print a single loud warning instead of
 * silently serving 404s so dev:admin failures are obvious (MVP-01).
 *
 * `/api/control` 还会在转发前注入 `Authorization: Bearer <token>`（如果
 * dev:admin 脚本通过 `PI_CONTROL_ADMIN_TOKEN_FILE` 提供了 token 文件），
 * 让前端无需也不能让用户输入 token。
 *
 * Vite 的 proxy 配置项没有官方强类型（属于 http-proxy 透传），这里用
 * `as` 窄化到我们实际用到的字段。
 */
export type ProxyEntry = {
	target: string;
	changeOrigin: boolean;
	ws?: boolean;
	configure?: (proxyServer: unknown) => void;
};

export function buildProxyConfig(
	embedTarget: string | undefined,
	adminTarget: string | undefined,
): Record<string, ProxyEntry> | undefined {
	const adminConfigure: ProxyEntry["configure"] = devAdminToken
		? (proxyServer) => {
				const server = proxyServer as {
					on?(event: string, listener: (...args: unknown[]) => void): void;
				};
				server.on?.("proxyReq", (...args: unknown[]) => {
					const proxyReq = args[0] as { setHeader?: (k: string, v: string) => void };
					proxyReq.setHeader?.("Authorization", `Bearer ${devAdminToken}`);
				});
			}
		: undefined;

	if (isEmbedOnly) {
		if (embedTarget === undefined) {
			console.warn(
				"[pi-web] PI_EMBED_DEV_PROXY_TARGET is not set; /api/embed requests will 404 in dev.",
			);
			return undefined;
		}
		return {
			"/api/control": { target: embedTarget, changeOrigin: false, configure: adminConfigure },
			"/api/embed": { target: embedTarget, changeOrigin: false, ws: true },
			"/api/voice-engine": { target: embedTarget, changeOrigin: false, ws: true },
		};
	}
	if (isAdminOnly) {
		if (adminTarget === undefined) {
			console.warn(
				"[pi-web] PI_ADMIN_DEV_PROXY_TARGET is not set; admin /api/control requests will return 404 in dev. " +
					"Run via the repo-root `npm run dev:admin` which sets this automatically.",
			);
			return undefined;
		}
		return {
			"/api/control": { target: adminTarget, changeOrigin: false, configure: adminConfigure },
			"/api/embed": { target: adminTarget, changeOrigin: false, ws: true },
			"/api/voice-engine": { target: adminTarget, changeOrigin: false, ws: true },
		};
	}
	if (embedTarget === undefined) {
		console.warn(
			"[pi-web] PI_EMBED_DEV_PROXY_TARGET is not set; /api/embed requests will 404 in dev.",
		);
		return {
			"/api/control": { target: adminTarget ?? "", changeOrigin: false, configure: adminConfigure },
		};
	}
	return {
		"/api/control": { target: embedTarget, changeOrigin: false, configure: adminConfigure },
		"/api/embed": { target: embedTarget, changeOrigin: false, ws: true },
		"/api/voice-engine": { target: embedTarget, changeOrigin: false, ws: true },
	};
}
