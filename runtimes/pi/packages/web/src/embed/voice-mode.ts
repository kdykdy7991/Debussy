export type PublishedChatMode = "text" | "voice";
export type PublishedChatSubmitSource = "composer" | "asr";

export function allowsPublishedChatSubmit(mode: PublishedChatMode, source: PublishedChatSubmitSource): boolean {
	return mode === "text" ? source === "composer" : source === "asr";
}

export interface VoiceModeResources {
	readonly asr: { cancel(): Promise<void> };
	readonly tts: { stop(sendStop?: boolean): Promise<void> };
	readonly transport: { close(): void };
}

/** Exit Voice Mode without leaving capture, playback, or the WS alive. */
export async function cleanupVoiceMode(resources: VoiceModeResources): Promise<void> {
	await Promise.allSettled([resources.asr.cancel(), resources.tts.stop()]);
	resources.transport.close();
}
