/**
 * MVP-06 tests.
 *
 *  - `buildEmbedUrl` / `buildIframeSnippet` / `buildSdkSnippet`: embed
 *    snippet builders use the real publicAppId + origin and never leak
 *    tokens / private material.
 *  - `readInitialQueryParam`: app-detail "用户会话" tab navigates with an
 *    `?appId=` query that the conversations index preloads.
 *  - `appendUnique` (already used by agents list) also applies to the app
 *    list cursor pagination (boundary dedup).
 */

import { describe, expect, it } from "vitest";
import { buildEmbedUrl, buildIframeSnippet, buildSdkSnippet } from "../../src/admin/apps/app-detail.tsx";
import { appendUnique } from "../../src/admin/pages/cursor-merge.ts";
import { adminConversationsPath, readInitialQueryParam } from "../../src/admin/user-conversations/query-params.ts";

const PUBLIC = "app_00000000-1111-2222-3333-444455556666";

describe("buildEmbedUrl / snippets (MVP-06 接入方式)", () => {
	it("builds an embed URL from origin + publicAppId", () => {
		expect(buildEmbedUrl("https://acme.example.com", PUBLIC)).toBe(`https://acme.example.com/embed/${PUBLIC}`);
	});

	it("strips a trailing slash from origin", () => {
		expect(buildEmbedUrl("https://acme.example.com/", PUBLIC)).toBe(`https://acme.example.com/embed/${PUBLIC}`);
	});

	it("iframe snippet embeds the publicAppId and the real URL", () => {
		const snippet = buildIframeSnippet("https://acme.example.com", PUBLIC);
		expect(snippet).toContain(`src="https://acme.example.com/embed/${PUBLIC}"`);
		expect(snippet).toContain(`title="Pi Embed ${PUBLIC}"`);
		// No token / key material must ever appear in the embed snippet.
		expect(snippet.toLowerCase()).not.toContain("token");
		expect(snippet.toLowerCase()).not.toContain("secret");
		expect(snippet.toLowerCase()).not.toContain("pem");
	});

	it("sdk snippet references the SDK with the publicAppId", () => {
		const snippet = buildSdkSnippet("https://acme.example.com", PUBLIC);
		expect(snippet).toContain(`publicAppId: "${PUBLIC}"`);
		expect(snippet).toContain("@earendil-works/pi-embed-sdk");
		expect(snippet.toLowerCase()).not.toContain("token");
	});
});

describe("readInitialQueryParam (MVP-06 conversations ?appId)", () => {
	it("returns the appId from a hash query", () => {
		// Simulate `#/conversations?appId=app_abc`
		const fake: Location = { hash: "#/conversations?appId=app_abc%20x" } as Location;
		expect(readInitialQueryParam("appId", fake)).toBe("app_abc x");
	});

	it("returns empty when there is no query", () => {
		const fake: Location = { hash: "#/conversations" } as Location;
		expect(readInitialQueryParam("appId", fake)).toBe("");
	});

	it("returns empty when the requested key is absent", () => {
		const fake: Location = { hash: "#/conversations?status=active" } as Location;
		expect(readInitialQueryParam("appId", fake)).toBe("");
	});

	it("buildAdminConversationsPrefill path encodes the appId filter", () => {
		expect(adminConversationsPath("app_abc 12")).toBe("/conversations?appId=app_abc%2012");
	});
});

describe("appendUnique on published-app ids (MVP-06 app list pagination)", () => {
	it("dedups a boundary row when the app list page turns", () => {
		const existing = [{ id: "app_a" }, { id: "app_b" }];
		const next = [{ id: "app_b" }, { id: "app_c" }];
		expect(appendUnique(existing, next).map((x) => x.id)).toEqual(["app_a", "app_b", "app_c"]);
	});
});
