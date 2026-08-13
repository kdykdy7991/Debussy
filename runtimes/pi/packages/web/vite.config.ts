import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@earendil-works/pi-client": fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5173,
	},
});
