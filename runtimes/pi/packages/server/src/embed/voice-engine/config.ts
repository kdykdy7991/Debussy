/**
 * Voice Engine 服务端配置（spec：MVP §4.2，Debussy 侧 §5.1）。
 *
 * 服务端配置 VoxEMW upstream URL 与 server-to-service token；浏览器绝不
 * 可见这两个值。同源 WS 反代使用它们连接到 VoxEMW，且 token 必须被进程
 * 级 SecretRegistry 注册以便日志脱敏。
 *
 * 任意一个 env 缺失 → 配置整体未启用（proxy 关闭），与 `voice-poc` 行为一致：
 * 调用方据此跳过 upgrade handler 注册。
 */
export interface VoiceEngineConfig {
	/** VoxEMW upstream base URL（ws:// 或 wss://）。 */
	readonly upstreamUrl: string;
	/** 服务间 bearer secret；绝不出现在浏览器、日志或 URL。 */
	readonly upstreamToken: string;
}

export function loadVoiceEngineConfig(env: NodeJS.ProcessEnv): VoiceEngineConfig | undefined {
	const upstreamUrl = env.PI_VOICE_ENGINE_URL;
	const upstreamToken = env.PI_VOICE_ENGINE_TOKEN;
	if (upstreamUrl === undefined && upstreamToken === undefined) return undefined;
	if (upstreamUrl === undefined || upstreamUrl === "") {
		throw new Error("PI_VOICE_ENGINE_URL is required when PI_VOICE_ENGINE_TOKEN is set");
	}
	if (upstreamToken === undefined || upstreamToken === "") {
		throw new Error("PI_VOICE_ENGINE_TOKEN is required when PI_VOICE_ENGINE_URL is set");
	}
	return { upstreamUrl, upstreamToken };
}
