/**
 * Wrap a {@link SpeechController} so its `speak()` call routes through the
 * page-level {@link PlaybackArbiter}. The arbiter stops any active live
 * playback before the new manual job opens (manual↔live mutex). Stop is a
 * thin pass-through because the controller already routes its own job.
 */

import type { PlaybackArbiter } from "../features/voice/playback-arbiter.ts";
import type { SpeechButtonApi } from "../features/voice/speech-button.tsx";
import type { SpeechController } from "../features/voice/speech-controller.ts";

export function wrapSpeechButtonApi(controller: SpeechController, arbiter: PlaybackArbiter): SpeechButtonApi {
	return {
		get activeMessageId() {
			return controller.activeMessageId;
		},
		subscribe: (listener) => controller.subscribe(listener),
		getState: () => controller.getState(),
		speak: (sessionId, messageId, voiceProfileId) =>
			arbiter.startManual(sessionId, messageId, voiceProfileId).catch((error: unknown) => {
				const detail = error instanceof Error ? error.message : String(error);
				console.error("无法开始手动朗读", detail);
				throw error;
			}),
		stop: () => controller.stop(),
	};
}
