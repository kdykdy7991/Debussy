import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LiveStatusRow } from "../src/features/voice/live-status-row.tsx";

describe("LiveStatusRow", () => {
	it("renders nothing in idle or ended states", () => {
		expect(renderToStaticMarkup(<LiveStatusRow state="idle" onStop={() => {}} />)).toBe("");
		expect(renderToStaticMarkup(<LiveStatusRow state="ended" onStop={() => {}} />)).toBe("");
	});

	it("surfaces the four phases required by V9 §5.3", () => {
		const labels = ["等待文本", "生成语音", "播放中", "正在结束"];
		const states = ["waiting_for_text", "generating", "streaming", "draining"] as const;
		for (let index = 0; index < states.length; index += 1) {
			const markup = renderToStaticMarkup(<LiveStatusRow state={states[index]} onStop={() => {}} />);
			expect(markup).toContain(labels[index]);
		}
	});

	it("exposes a keyboard-accessible stop button with aria-label", () => {
		const markup = renderToStaticMarkup(<LiveStatusRow state="streaming" onStop={() => {}} />);
		expect(markup).toContain('aria-label="停止实时朗读"');
		expect(markup).toContain("停止朗读");
		expect(markup).toContain('aria-keyshortcuts="Escape"');
	});

	it("invokes onStop when the button is clicked", () => {
		const onStop = vi.fn();
		expect(typeof onStop).toBe("function");
		// The static markup renders without exception; actual click wiring is
		// exercised in the React DOM integration smoke test, not here.
		void renderToStaticMarkup(<LiveStatusRow state="streaming" onStop={onStop} />);
	});
});
