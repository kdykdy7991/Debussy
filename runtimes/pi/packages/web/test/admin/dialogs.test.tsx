import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConfirmModal } from "../../src/admin/components/confirm-modal.tsx";
import { DialogQueue } from "../../src/admin/components/dialog-queue.ts";
import { McpTokenDialog } from "../../src/admin/components/mcp-token-dialog.tsx";

describe("shared dialog decisions", () => {
	it("keeps overlapping requests in order and ignores duplicate decisions", async () => {
		const queue = new DialogQueue();
		const first = queue.ask("confirm", "删除？");
		const firstRequest = queue.getSnapshot()!;
		const second = queue.ask("prompt", "名称");
		expect(queue.getSnapshot()).toBe(firstRequest);
		queue.settle(firstRequest, "");
		await expect(first).resolves.toBe("");
		const secondRequest = queue.getSnapshot()!;
		expect(secondRequest.message).toBe("名称");
		queue.settle(firstRequest, "stale");
		expect(queue.getSnapshot()).toBe(secondRequest);
		queue.settle(secondRequest, "Agent A");
		await expect(second).resolves.toBe("Agent A");
		expect(queue.getSnapshot()).toBeNull();
	});
	it("cancels all pending decisions on unmount and refuses late requests", async () => {
		const queue = new DialogQueue();
		const first = queue.ask("confirm", "删除？");
		const second = queue.ask("prompt", "名称");
		queue.dispose();
		await expect(first).resolves.toBeNull();
		await expect(second).resolves.toBeNull();
		await expect(queue.ask("confirm", "过期操作")).resolves.toBeNull();
		expect(queue.getSnapshot()).toBeNull();
	});
	it("supports effect setup after cleanup without resurrecting cancelled operations", async () => {
		const queue = new DialogQueue();
		const cancelled = queue.ask("confirm", "old");
		queue.dispose();
		queue.activate();
		await expect(cancelled).resolves.toBeNull();
		const current = queue.ask("confirm", "new");
		queue.settle(queue.getSnapshot()!, null);
		await expect(current).resolves.toBeNull();
	});
	it("notifies subscribers when a decision advances", () => {
		const queue = new DialogQueue();
		const listener = vi.fn();
		const unsubscribe = queue.subscribe(listener);
		void queue.ask("alert", "完成");
		queue.settle(queue.getSnapshot()!, "");
		expect(listener).toHaveBeenCalledTimes(2);
		unsubscribe();
		queue.dispose();
		expect(listener).toHaveBeenCalledTimes(2);
	});
});

describe("shared modal markup", () => {
	const props = {
		open: true,
		title: "删除 Agent",
		body: "请确认操作",
		confirmLabel: "确认删除",
		onConfirm: vi.fn(),
		onCancel: vi.fn(),
	};
	it.each(["", "wrong", "Agent A "])("keeps deletion disabled until the name matches exactly: %s", (defaultValue) => {
		const html = renderToStaticMarkup(
			<ConfirmModal {...props} typeToConfirm="Agent A" defaultValue={defaultValue} destructive />,
		);
		expect(html).toMatch(/<button type="submit"[^>]*disabled/);
		expect(html).toContain("名称须完全一致");
	});
	it("allows a matching typed confirmation, with labelled dialog semantics", () => {
		const html = renderToStaticMarkup(<ConfirmModal {...props} typeToConfirm="Agent A" defaultValue="Agent A" />);
		expect(html).toContain("<dialog");
		expect(html).toContain("aria-labelledby=");
		expect(html).not.toMatch(/<button type="submit"[^>]*disabled/);
	});
	it("keeps blank prompts disabled and shows a single action for alerts", () => {
		const prompt = renderToStaticMarkup(<ConfirmModal {...props} inputLabel="Agent 名称" defaultValue="   " />);
		expect(prompt).toMatch(/<button type="submit"[^>]*disabled/);
		const alert = renderToStaticMarkup(<ConfirmModal {...props} hideCancel />);
		expect(alert).not.toContain(">取消</button>");
	});
	it("does not render closed dialogs or interpret message text as HTML", () => {
		expect(renderToStaticMarkup(<ConfirmModal {...props} open={false} />)).toBe("");
		expect(renderToStaticMarkup(<ConfirmModal {...props} body="<script>alert(1)</script>" />)).toContain(
			"&lt;script&gt;",
		);
	});
	it("uses the shared modal shell for credentials without exposing a saved value", () => {
		const html = renderToStaticMarkup(
			<McpTokenDialog
				target={{ id: "mcp_test", name: "Dify", endpoint: "https://mcp.test", credentialLabel: "API Key" }}
				onSave={async () => {}}
				onClose={() => {}}
			/>,
		);
		expect(html.match(/<dialog/g)).toHaveLength(1);
		expect(html.match(/<form/g)).toHaveLength(1);
		expect(html).toContain('type="password"');
		expect(html).toContain("API Key 的值");
	});
});
