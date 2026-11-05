import { describe, expect, it, vi } from "vitest";
import { McpApiError } from "../../src/admin/api/mcp-api.ts";
import { deleteMcpWithConfirmation } from "../../src/admin/pages/mcp-delete.ts";

describe("MCP deletion", () => {
	it("deletes normally without asking to force", async () => {
		const api = { delete: vi.fn().mockResolvedValue({ deleted: true }), forceDelete: vi.fn() };
		const confirm = vi.fn();
		await deleteMcpWithConfirmation(api, "mcp_one", confirm);
		expect(api.delete).toHaveBeenCalledWith("mcp_one");
		expect(confirm).not.toHaveBeenCalled();
		expect(api.forceDelete).not.toHaveBeenCalled();
	});
	it.each([true, false])("requires confirmation before forcing: %s", async (confirmed) => {
		const api = {
			delete: vi.fn().mockRejectedValue(new McpApiError("referenced", 409, null, "MCP_BINDING_VIOLATION")),
			forceDelete: vi.fn().mockResolvedValue({ deleted: true }),
		};
		await deleteMcpWithConfirmation(api, "mcp_one", async () => confirmed);
		expect(api.forceDelete).toHaveBeenCalledTimes(confirmed ? 1 : 0);
	});
	it("does not force on unrelated errors", async () => {
		const error = new McpApiError("other", 409, null, "OTHER");
		const api = { delete: vi.fn().mockRejectedValue(error), forceDelete: vi.fn() };
		await expect(deleteMcpWithConfirmation(api, "mcp_one", async () => true)).rejects.toBe(error);
		expect(api.forceDelete).not.toHaveBeenCalled();
	});
});
