import { describe, expect, it } from "vitest";
import { type CompactionMode, SettingsManager } from "../src/index.ts";

describe("compaction mode (Debussy integration gate)", () => {
	it("defaults to 'auto' so Pi's normal behavior is unchanged", () => {
		const sm = SettingsManager.inMemory();
		expect(sm.getCompactionSettings().compactionMode).toBe("auto");
	});

	it("setRuntimeCompactionMode reflects immediately in getCompactionSettings", () => {
		const sm = SettingsManager.inMemory();
		sm.setRuntimeCompactionMode("overflow-only");
		expect(sm.getCompactionSettings().compactionMode).toBe("overflow-only");
	});

	it("setRuntimeCompactionMode does NOT persist to the storage scope", () => {
		const sm = SettingsManager.inMemory();
		sm.setRuntimeCompactionMode("disabled");
		// Reading the raw global settings (what would be written to disk) must not
		// carry the runtime-only mode.
		expect(sm.getGlobalSettings()?.compaction?.compactionMode).toBeUndefined();
		// A brand-new manager from the same storage never sees the mode.
		const sm2 = SettingsManager.inMemory();
		expect(sm2.getCompactionSettings().compactionMode).toBe("auto");
	});

	it("accepts all three documented modes", () => {
		const modes: CompactionMode[] = ["auto", "overflow-only", "disabled"];
		for (const mode of modes) {
			const sm = SettingsManager.inMemory();
			sm.setRuntimeCompactionMode(mode);
			expect(sm.getCompactionMode()).toBe(mode);
		}
	});
});
