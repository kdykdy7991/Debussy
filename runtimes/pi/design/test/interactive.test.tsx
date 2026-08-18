// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
	AgentTrace,
	AgentTraceEvent,
	Composer,
	MessageActions,
	type AgentTraceEventStatus
} from "../src";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(element: React.ReactElement) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	act(() => {
		root.render(element);
	});
	return {
		container,
		rerender: (next: React.ReactElement) => {
			act(() => {
				root.render(next);
			});
		},
		unmount: () => {
			act(() => {
				root.unmount();
			});
			container.remove();
		}
	};
}

/** 触发 React 受控 textarea 的 change（native setter + input 事件）。 */
function typeText(textarea: HTMLTextAreaElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
	if (!setter) throw new Error("jsdom textarea value setter missing");
	setter.call(textarea, value);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function keydown(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
	target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

describe("交互行为（jsdom）", () => {
	it("Composer：Enter 提交并清空；Shift+Enter 不提交", async () => {
		const submitted: string[] = [];
		const { container, unmount } = mount(<Composer onSubmit={(t) => submitted.push(t)} />);
		const ta = container.querySelector("textarea") as HTMLTextAreaElement;

		await act(async () => {
			typeText(ta, "  帮我分析 Q3  ");
		});
		await act(async () => {
			keydown(ta, "Enter", { shiftKey: true });
		});
		expect(submitted).toHaveLength(0); // Shift+Enter 换行，不提交
		await act(async () => {
			keydown(ta, "Enter");
		});
		expect(submitted).toEqual(["帮我分析 Q3"]); // trim 后提交
		expect(ta.value).toBe(""); // 提交后清空
		unmount();
	});

	it("Composer：空输入 / 唤起菜单；streaming 时显示 Stop", async () => {
		const { container, rerender, unmount } = mount(
			<Composer onSubmit={() => {}} menuItems={[{ label: "📎 上传文件" }]} />
		);
		const ta = container.querySelector("textarea") as HTMLTextAreaElement;
		const plus = container.querySelector(".ai-composer-plus") as HTMLButtonElement;

		await act(async () => {
			keydown(ta, "/");
		});
		expect(container.querySelector(".ai-composer-menu")?.className).toContain("is-open");

		await act(async () => {
			plus.click();
		});
		expect(container.querySelector(".ai-composer-menu")?.className).not.toContain("is-open");

		rerender(
			<Composer onSubmit={() => {}} streaming onStop={() => {}} menuItems={[{ label: "📎 上传文件" }]} />
		);
		expect(container.querySelector(".ai-composer-go")?.textContent).toContain("停止");
		unmount();
	});

	it("AgentTraceEvent：生命周期原地更新（同一 DOM node，不重建）", async () => {
		function Harness({ status }: { status: AgentTraceEventStatus }) {
			return (
				<AgentTrace status="running">
					<AgentTraceEvent status={status} title="检索知识库" detail="3 documents" />
				</AgentTrace>
			);
		}

		const { container, rerender, unmount } = mount(<Harness status="pending" />);
		const firstNode = container.querySelector(".ai-trace-evt") as HTMLElement;
		expect(firstNode.className).toContain("is-pending");

		await act(async () => {
			rerender(<Harness status="running" />);
		});
		const runningNode = container.querySelector(".ai-trace-evt") as HTMLElement;
		expect(runningNode).toBe(firstNode); // 同一 node —— tool result 不新建节点
		expect(runningNode.className).toContain("is-running");

		await act(async () => {
			rerender(<Harness status="completed" />);
		});
		expect(container.querySelector(".ai-trace-evt")).toBe(firstNode);
		expect((container.querySelector(".ai-trace-evt") as HTMLElement).className).toContain("is-completed");
		unmount();
	});

	it("AgentTrace：summary 上限 5，披露点击后展开全部", async () => {
		const events = Array.from({ length: 8 }, (_, i) => (
			<AgentTraceEvent key={`e${i}`} status="completed" title={`步骤 ${i + 1}`} />
		));
		const { container, unmount } = mount(<AgentTrace status="completed">{events}</AgentTrace>);

		expect(container.querySelectorAll(".ai-trace-evt")).toHaveLength(5);
		const more = container.querySelector(".ai-trace-more button") as HTMLButtonElement;
		expect(more.textContent).toBe("查看 3 次调用的完整轨迹 →");

		await act(async () => {
			more.click();
		});
		expect(container.querySelectorAll(".ai-trace-evt")).toHaveLength(8);
		unmount();
	});

	it("MessageActions：visible 切换 actions-enter 状态类", async () => {
		const { container, rerender, unmount } = mount(<MessageActions items={[{ label: "复制" }]} visible={false} />);
		const actions = container.querySelector(".ai-actions") as HTMLElement;
		expect(actions.className).not.toContain("is-visible");

		await act(async () => {
			rerender(<MessageActions items={[{ label: "复制" }]} />);
		});
		expect((container.querySelector(".ai-actions") as HTMLElement).className).toContain("is-visible");
		unmount();
	});
});
