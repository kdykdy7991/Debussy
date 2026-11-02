import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ContextUsageRing } from "../../src/embed/context-usage-ring.tsx";

describe("context usage display", () => {
	test("shows the conversation estimate as a percentage of the window", () => {
		const markup = renderToStaticMarkup(
			<ContextUsageRing usedTokens={42384} contextWindow={100000} workingBudget={29454}
				usagePercent={143.9} summaryThroughSequence={8} busy={false} onCompact={async () => true} />,
		);
		expect(markup).toContain("上下文已用 42.4%");
		expect(markup).not.toContain("143.9%");
		expect(markup).not.toContain("摘要状态");
		expect(markup).toContain("不含系统指令和工具等开销");
	});
});
