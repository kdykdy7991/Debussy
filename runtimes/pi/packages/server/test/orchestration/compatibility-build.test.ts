import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { composeOrchestration } from "../../src/orchestration/compose.ts";

test("startup rejects a stale coding-agent build before creating a dispatcher", async () => {
	const descriptor = Object.getOwnPropertyDescriptor(SettingsManager.prototype, "setRuntimeCompactionMode");
	if (!descriptor) throw new Error("test requires a current coding-agent build");
	Object.defineProperty(SettingsManager.prototype, "setRuntimeCompactionMode", { ...descriptor, value: undefined });
	try {
		await expect(composeOrchestration({} as never)).rejects.toThrow(/matching pi-coding-agent build/);
	} finally {
		Object.defineProperty(SettingsManager.prototype, "setRuntimeCompactionMode", descriptor);
	}
});
