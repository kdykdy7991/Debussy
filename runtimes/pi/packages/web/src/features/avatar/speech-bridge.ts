import type { AvatarController } from "@skdy/avatar";
import type { PlaybackEndReason, SpeechControllerHooks } from "../voice/types.ts";

export interface AvatarSpeechBridgeOptions {
	controller?: AvatarController;
	onError?: (error: unknown) => void;
}

/** Optional, failure-isolated adapter from V3 playback hooks to Avatar. */
export class AvatarSpeechBridge {
	readonly #onError: (error: unknown) => void;
	#controller: AvatarController | undefined;
	#attached = false;
	#generation = 0;

	constructor(options: AvatarSpeechBridgeOptions = {}) {
		this.#controller = options.controller;
		this.#attached = options.controller !== undefined;
		this.#onError = options.onError ?? (() => {});
	}

	get hooks(): SpeechControllerHooks {
		return {
			onPlaybackStart: () => this.#invoke((controller) => controller.setState("speaking")),
			onAudioLevel: (level) =>
				this.#invoke((controller) =>
					controller.setAudioLevel(Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0),
				),
			onPlaybackEnd: (_reason) =>
				this.#invoke((controller) => {
					controller.setAudioLevel(0);
					controller.setState("idle");
				}),
		};
	}

	attach(controller: AvatarController): void {
		this.detach(false);
		this.#controller = controller;
		this.#attached = true;
		this.#generation += 1;
	}

	detach(zero = true): void {
		const controller = this.#controller;
		this.#attached = false;
		this.#controller = undefined;
		this.#generation += 1;
		if (zero && controller) {
			try {
				controller.setAudioLevel(0);
			} catch (error) {
				this.#onError(error);
			}
		}
	}

	#invoke(action: (controller: AvatarController) => void): void {
		const generation = this.#generation;
		const controller = this.#controller;
		if (!this.#attached || !controller) return;
		try {
			if (generation !== this.#generation) return;
			action(controller);
		} catch (error) {
			this.#attached = false;
			this.#controller = undefined;
			this.#generation += 1;
			this.#onError(error);
		}
	}
}

export function createAvatarSpeechHooks(options: AvatarSpeechBridgeOptions = {}): {
	bridge: AvatarSpeechBridge;
	hooks: SpeechControllerHooks;
} {
	const bridge = new AvatarSpeechBridge(options);
	return { bridge, hooks: bridge.hooks };
}

export type { PlaybackEndReason };
