/**
 * WB-001 构建边界测试。
 *
 * 通过 `PI_WEB_TARGET=embed vite build` 生成 embed 产物，扫描 dist/embed/
 * 全部静态资源，断言不包含：
 *
 * - PublishingApp / PublishingController / publishing 路径
 * - AdminAuthController / admin auth 相关
 * - "/api/control" 路径
 * - "Admin Token" 等管理文案
 * - "/api/pi/v1/ws"（内部管理员 WebSocket）
 *
 * 任何命中即 fail。同步跑 build 一次，缓存在 beforeAll 钩子；开发者可单独
 * 执行 `PI_WEB_TARGET=embed npm run build:embed` 后再跑本文件。
 *
 * 严禁通过动态 import 掩盖同一 bundle；此测试只检查实际产物。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const webRoot = resolve(__dirname, "..");
const distEmbed = join(webRoot, "dist", "embed");

function buildEmbed(): void {
	const result = spawnSync("npx", ["vite", "build"], {
		cwd: webRoot,
		env: { ...process.env, PI_WEB_TARGET: "embed", NODE_ENV: "production" },
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 180_000,
	});
	if (result.status !== 0) {
		const stderr = result.stderr?.toString() ?? "";
		const stdout = result.stdout?.toString() ?? "";
		throw new Error(
			`vite build (PI_WEB_TARGET=embed) failed with code ${String(result.status)}.\nstdout: ${stdout}\nstderr: ${stderr}`,
		);
	}
}

function collectJs(dir: string, acc: string[] = []): string[] {
	if (!existsSync(dir)) return acc;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			collectJs(full, acc);
		} else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".css"))) {
			acc.push(readFileSync(full, "utf8"));
		}
	}
	return acc;
}

describe("embed build boundary (WB-001)", () => {
	let bundle: string;

	beforeAll(() => {
		if (!existsSync(distEmbed)) {
			buildEmbed();
		}
		const files = collectJs(distEmbed);
		if (files.length === 0) {
			throw new Error(
				`No .js/.css files under ${distEmbed}. Run \`PI_WEB_TARGET=embed npm run build:embed\` manually first.`,
			);
		}
		bundle = files.join("\n");
	}, 180_000);

	it("does not include publishing module identifiers", () => {
		expect(bundle).not.toMatch(/PublishingApp/);
		expect(bundle).not.toMatch(/PublishingController/);
		expect(bundle).not.toMatch(/publishing-controller/);
		expect(bundle).not.toMatch(/createAppWizard/);
		expect(bundle).not.toMatch(/launch-key-panel/);
	});

	it("does not include admin auth controller", () => {
		expect(bundle).not.toMatch(/AdminAuthController/);
		expect(bundle).not.toMatch(/publishing[/\\]auth-controller/);
	});

	it("does not reference /api/control", () => {
		expect(bundle).not.toMatch(/\/api\/control/);
	});

	it("does not contain 'Admin Token' text", () => {
		expect(bundle).not.toMatch(/Admin Token/);
	});

	it("does not reference the internal /api/pi/v1/ws endpoint", () => {
		expect(bundle).not.toMatch(/\/api\/pi\/v1\/ws/);
	});

	it("contains embed route handling for /embed/:publicAppId", () => {
		expect(bundle).toMatch(/pub_/);
		expect(bundle).toMatch(/\/embed\//);
	});
});
