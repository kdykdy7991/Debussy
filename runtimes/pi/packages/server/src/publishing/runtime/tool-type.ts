/**
 * Shared tool-type derivation for conversation services (Production embed +
 * DebugConversation Phase 2A).
 *
 * Mapping rule (mirrored from Production embed/conversations/service.ts):
 *   - skill name hit          -> "skill"
 *   - mcp server tool hit     -> "mcp"
 *   - otherwise               -> "builtin"
 *
 * Skills are surfaced primarily via ResourceLoader (`/skill:name` +
 * progressive `<available_skills>` disclosure), not as ToolDefinition tools.
 * A tool whose name happens to match a bound Skill name is therefore tagged
 * "skill" — we do NOT retrofit Skills into ToolDefinitions just to obtain the
 * label. The runtime's tool registry for executable tools is the
 * AgentSession's `_baseToolDefinitions` + `customTools` (MCP).
 */
import type { RuntimeSpec } from "../runtime-spec/schema.ts";

export type DebugToolType = "builtin" | "mcp" | "skill";

export function deriveToolType(spec: RuntimeSpec, toolName: string): DebugToolType {
	if (spec.capabilities.skills.some((skill) => skill.name === toolName)) return "skill";
	if (spec.capabilities.mcpServers.some((server) => server.tools.some((tool) => tool.name === toolName))) {
		return "mcp";
	}
	return "builtin";
}
