/**
 * 匿名访客身份存储（spec 7.1 / PD-17，TASK-019）。
 *
 * visitorId 保存在 iframe 自身 localStorage（不依赖第三方 Cookie）；清理
 * 浏览器数据产生新匿名身份（PD-02）。用可注入的 `StorageLike` 便于测试。
 */

export interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export function createVisitorStorage(storage: StorageLike): {
	getVisitorId(): string | null;
	getOrCreateVisitorId(): string;
	clearVisitorId(): void;
} {
	const key = "skdy.embed.anonymousVisitorId";
	return {
		getVisitorId() {
			const value = storage.getItem(key);
			return value !== null && value !== "" ? value : null;
		},
		getOrCreateVisitorId() {
			const existing = this.getVisitorId();
			if (existing !== null) return existing;
			const fresh = newVisitorId();
			storage.setItem(key, fresh);
			return fresh;
		},
		clearVisitorId() {
			storage.removeItem(key);
		},
	};
}

/** 生成 256-bit 随机 visitorId（base64url，43 字符；spec 7.1）。 */
export function newVisitorId(): string {
	const bytes = new Uint8Array(32);
	if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
	}
	return toBase64Url(bytes);
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
