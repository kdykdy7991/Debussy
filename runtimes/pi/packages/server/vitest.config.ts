import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		alias: [
			{
				find: /^@earendil-works\/pi-coding-agent\/skills$/,
				replacement: fileURLToPath(new URL("../coding-agent/src/skills.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/pi-coding-agent$/,
				replacement: fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/pi-protocol$/,
				replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
			},
		],
	},
});
