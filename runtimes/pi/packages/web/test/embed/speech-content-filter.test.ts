import { describe, expect, it } from "vitest";
import { filterSpeechContent } from "../../src/embed/speech-content-filter.ts";

describe("Speech Content Filter", () => {
	it("keeps natural language and removes Markdown presentation markers", () => {
		expect(filterSpeechContent("## 结果\n\n这是**重要**内容，也是*自然语言*。\n\n- 第一项\n- 第二项")).toBe(
			"结果\n这是重要内容，也是自然语言。\n第一项\n第二项",
		);
	});

	it("speaks a link label but never its destination or a bare URL", () => {
		expect(
			filterSpeechContent("请查看 [使用说明](https://example.com/docs)，不要朗读 https://example.com/raw。"),
		).toBe("请查看 使用说明，不要朗读");
	});

	it("skips machine-oriented AST nodes as complete content units", () => {
		const markdown = [
			"前面的自然语言。",
			"```ts",
			"const value = 42;",
			"```",
			"行内 `npm test` 不朗读。",
			"| 名称 | 数值 |",
			"| --- | ---: |",
			"| foo | 42 |",
			"",
			"公式 $E = mc^2$ 和下面的公式都跳过。",
			"",
			"$$",
			"x = \\frac{-b}{2a}",
			"$$",
			"",
			"<aside>机器生成的 HTML</aside>",
			"",
			"![架构图](https://example.com/diagram.png)",
			"",
			"后面的自然语言。",
		].join("\n");
		expect(filterSpeechContent(markdown)).toBe(
			"前面的自然语言。\n行内 不朗读。\n公式 和下面的公式都跳过。\n后面的自然语言。",
		);
	});

	it("uses an allowlist so unknown rich-content nodes do not leak into speech", () => {
		expect(filterSpeechContent("---\n\n[^note]: 技术脚注\n\n正文。[^note]")).toBe("正文。");
	});
});
