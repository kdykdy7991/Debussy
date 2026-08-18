import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url))
		}
	},
	server: {
		port: 15199,
		strictPort: true,
		open: "/demo/"
	},
	build: {
		rollupOptions: {
			input: fileURLToPath(new URL("./demo/index.html", import.meta.url))
		}
	}
});
