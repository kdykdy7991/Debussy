import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentTrace } from "../src/ai-kit/components/ai/agent-trace.tsx";
import { AgentTraceEvent } from "../src/ai-kit/components/ai/agent-trace-event.tsx";

describe("AgentTrace responsive collapse", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("defaults to collapsed on narrow screens", () => {
		vi.stubGlobal("window", {
			matchMedia: () => ({ matches: true }),
		});

		const html = renderToStaticMarkup(
			<AgentTrace status="running">
				<AgentTraceEvent title="调用工具" status="running" />
			</AgentTrace>,
		);

		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain("1 步");
		expect(html).not.toContain("调用工具");
	});
});
