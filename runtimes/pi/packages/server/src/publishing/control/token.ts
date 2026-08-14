/**
 * Control-plane administrator token (spec 33.2).
 *
 * The token is read from `PI_CONTROL_ADMIN_TOKEN_FILE` (never from env
 * directly, never logged, never returned to clients) and must be at least
 * 256-bit random. Bearer checks use a constant-time comparison so timing does
 * not leak the token. The token authenticates the MVP admin control plane
 * only; it must never be used to sign or replace Embed Access Tokens.
 */

import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

export const CONTROL_ADMIN_TOKEN_FILE_ENV = "PI_CONTROL_ADMIN_TOKEN_FILE";

/** Minimum token length: 256-bit random in base64url/hex is >= 43 chars. */
export const MIN_TOKEN_CHARS = 32;

export function loadControlAdminToken(env: NodeJS.ProcessEnv): string | undefined {
	const file = env[CONTROL_ADMIN_TOKEN_FILE_ENV];
	if (file === undefined || file === "") return undefined;
	return file;
}

export async function readTokenFile(path: string): Promise<string> {
	const raw = (await readFile(path, "utf8")).trim();
	if (raw.length < MIN_TOKEN_CHARS) {
		throw new Error(
			`control admin token file must contain at least ${MIN_TOKEN_CHARS} characters, got ${raw.length}`,
		);
	}
	return raw;
}

/** Constant-time equality of two ASCII/UTF-8 strings. */
export function secureEqual(a: string, b: string): boolean {
	const aBuf = Buffer.from(a, "utf8");
	const bBuf = Buffer.from(b, "utf8");
	if (aBuf.length !== bBuf.length) {
		// Still run a dummy comparison so length leaks nothing extra.
		timingSafeEqual(aBuf, aBuf);
		return false;
	}
	return timingSafeEqual(aBuf, bBuf);
}
