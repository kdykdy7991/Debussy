import { type McpApi, McpApiError } from "../api/mcp-api.ts";

export async function deleteMcpWithConfirmation(
	api: Pick<McpApi, "delete" | "forceDelete">,
	id: string,
	confirmForce: () => Promise<boolean>,
): Promise<void> {
	try {
		await api.delete(id);
	} catch (cause) {
		if (!(cause instanceof McpApiError) || cause.httpStatus !== 409 || cause.code !== "MCP_BINDING_VIOLATION")
			throw cause;
		if (await confirmForce()) await api.forceDelete(id);
	}
}
