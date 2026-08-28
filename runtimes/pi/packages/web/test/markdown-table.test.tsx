import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { MarkdownText } from "../src/conversation/ai-message-flow.tsx";

describe("conversation Markdown", () => {
	test("renders GFM tables inside the styled Markdown container", () => {
		const html = renderToStaticMarkup(
			<MarkdownText text={"| 名称 | 状态 |\n| --- | --- |\n| 知识库 | 可用 |"} streaming={false} />,
		);

		expect(html).toContain('class="ai-prose-block ai-markdown"');
		expect(html).toContain('class="ai-markdown-table"');
		expect(html).toContain("<table");
		expect(html).toContain("<th>名称</th>");
		expect(html).toContain("<td>可用</td>");
	});
});
