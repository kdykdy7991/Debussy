import { afterEach, describe, expect, test, vi } from "vitest";
import { copyTextToClipboard } from "../../src/conversation/copy-text.ts";

afterEach(() => vi.unstubAllGlobals());

describe("copyTextToClipboard", () => {
	test("uses the Clipboard API when available", async () => {
		const writeText = vi.fn(async () => {});
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		expect(await copyTextToClipboard("回答正文")).toBe(true);
		expect(writeText).toHaveBeenCalledWith("回答正文");
	});

	test("copies through selection on an HTTP LAN page without the Clipboard API", async () => {
		const field = { value: "", style: {}, setAttribute: vi.fn(), focus: vi.fn(), select: vi.fn(), remove: vi.fn() };
		const execCommand = vi.fn(() => true);
		vi.stubGlobal("navigator", {});
		vi.stubGlobal("HTMLElement", class {});
		vi.stubGlobal("document", {
			activeElement: null,
			createElement: vi.fn(() => field),
			body: { appendChild: vi.fn() },
			execCommand,
		});
		expect(await copyTextToClipboard("回答正文")).toBe(true);
		expect(field.value).toBe("回答正文");
		expect(field.select).toHaveBeenCalledOnce();
		expect(execCommand).toHaveBeenCalledWith("copy");
		expect(field.remove).toHaveBeenCalledOnce();
	});
});
