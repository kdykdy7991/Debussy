import { type AgentDefinitionId, fromPublicId, parseId } from "../publishing/domain/ids.ts";

export interface VoicePocConfig {
	readonly agentDefinitionId: AgentDefinitionId;
	readonly token: string;
}

export function loadVoicePocConfig(env: NodeJS.ProcessEnv): VoicePocConfig | undefined {
	const agentId = env.VOICE_POC_AGENT_ID;
	const token = env.VOICE_POC_TOKEN;
	const values = [agentId, token];
	if (values.every((value) => value === undefined)) return undefined;
	if (values.some((value) => value === undefined || value === "")) {
		throw new Error("VOICE_POC_AGENT_ID and VOICE_POC_TOKEN must be set together");
	}
	const agentDefinitionId = fromPublicId("AgentDefinitionId", agentId!) ?? parseId("AgentDefinitionId", agentId!);
	if (agentDefinitionId === null) {
		throw new Error("VOICE_POC_AGENT_ID must be an agent_<uuid> public id or bare UUID");
	}
	return {
		agentDefinitionId,
		token: token!,
	};
}
