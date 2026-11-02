import { resolve } from "node:path";
import { expect, test } from "vitest";
import { isPublicEmbedDevPath } from "../vite.config.ts";

test("LAN access includes the embed page, its dev assets, and embed APIs", () => {
	expect(isPublicEmbedDevPath("/embed/pub_01a11f5f-b98e-76ef-8f79-afd6a828a538")).toBe(true);
	expect(isPublicEmbedDevPath("/embed.html")).toBe(true);
	expect(isPublicEmbedDevPath("/src/embed/embed-app.tsx?t=123")).toBe(true);
	expect(isPublicEmbedDevPath("/@vite/client")).toBe(true);
	expect(isPublicEmbedDevPath(`/@fs${resolve(__dirname, "../../protocol/src/index.ts")}`)).toBe(true);
	expect(isPublicEmbedDevPath("/api/embed/v1/bootstrap?publicAppId=pub_test")).toBe(true);
});

test("LAN access excludes the admin page and token-bearing admin proxy", () => {
	expect(isPublicEmbedDevPath("/")).toBe(false);
	expect(isPublicEmbedDevPath("/index.html")).toBe(false);
	expect(isPublicEmbedDevPath("/api/control/v1/agent-definitions")).toBe(false);
	expect(isPublicEmbedDevPath("/api/admin/v1/trusted-apps")).toBe(false);
	expect(isPublicEmbedDevPath("/admin/agents")).toBe(false);
	expect(isPublicEmbedDevPath("/@fs/home/hello/workspace/pi/.pi/admin-dev/control-admin-token")).toBe(false);
});
