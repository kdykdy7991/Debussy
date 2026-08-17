import react from "@vitejs/plugin-react";
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

function routeRewritePlugin(): PluginOption {
	return {
		name: "pi-web-route-rewrite",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use((req, _res, next) => {
				const url = req.url ?? "/";
				if (isEmbedOnly) {
					if (url === "/" || url === "" || url === "/index.html") {
						req.url = "/embed.html";
					} else if (url.startsWith("/embed/")) {
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
				if (/^\/embed\/pub_[0-9a-fA-F-]{36}(\/|$|\?)/.test(url)) {
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
		proxy:
			process.env.PI_EMBED_DEV_PROXY_TARGET === undefined
				? undefined
				: {
						"/api/control": {
							target: process.env.PI_EMBED_DEV_PROXY_TARGET,
							changeOrigin: false,
						},
						"/api/embed": {
							target: process.env.PI_EMBED_DEV_PROXY_TARGET,
							changeOrigin: false,
							ws: true,
						},
					},
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
