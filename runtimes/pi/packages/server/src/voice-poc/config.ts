export interface VoicePocConfig {
	readonly token: string;
}

export function loadVoicePocConfig(env: NodeJS.ProcessEnv): VoicePocConfig | undefined {
	const token = env.VOICE_POC_TOKEN;
	if (token === undefined) return undefined;
	if (token === "") throw new Error("VOICE_POC_TOKEN must not be empty");
	return { token };
}
