/**
 * Pure audio-level analysis for the avatar linkage (V4).
 *
 * These functions convert raw time-domain samples into a stable, normalized
 * 0..1 volume that drives `AvatarController.setAudioLevel`. They are pure and
 * DOM-free so they can be unit-tested deterministically without a sound card,
 * a real AnalyserNode, or the Rive CDN.
 *
 * Pipeline (per animation frame):
 *
 *   raw samples -> RMS -> noise gate -> smoothing -> clamp to 0..1
 *
 * Constants follow `docs/avatar/tasks/A8-audio-analyser.md` and the Pi speech
 * spec §11.5; they are frozen defaults that must stay deterministic in tests.
 */

/** RMS below this value is treated as silence. */
export const DEFAULT_NOISE_GATE_THRESHOLD = 0.004;

/** One-pole low-pass factor; higher responds faster. */
export const DEFAULT_SMOOTHING_ALPHA = 0.3;

export interface AudioLevelOptions {
	/** RMS below this value becomes 0. Defaults to `DEFAULT_NOISE_GATE_THRESHOLD`. */
	noiseGateThreshold?: number;
	/** Smoothing factor in (0, 1]. Defaults to `DEFAULT_SMOOTHING_ALPHA`. */
	smoothingAlpha?: number;
}

function clamp01(value: number): number {
	return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/**
 * Compute the time-domain RMS of a float32 sample buffer.
 *
 * Non-finite samples (NaN / Infinity) are rejected and contribute zero. Every
 * finite sample is clamped to [-1, 1] before squaring so the RMS is always
 * finite and bounded by 1. An empty buffer is silent.
 */
export function computeRms(samples: Float32Array): number {
	if (samples.length === 0) {
		return 0;
	}
	let sumSquares = 0;
	for (let index = 0; index < samples.length; index += 1) {
		const sample = samples[index];
		if (!Number.isFinite(sample)) {
			continue;
		}
		const clamped = sample <= -1 ? -1 : sample >= 1 ? 1 : sample;
		sumSquares += clamped * clamped;
	}
	return clamp01(Math.sqrt(sumSquares / samples.length));
}

/**
 * Zero out RMS below the noise gate. Non-finite input becomes 0.
 */
export function applyNoiseGate(rms: number, threshold: number = DEFAULT_NOISE_GATE_THRESHOLD): number {
	if (!Number.isFinite(rms)) {
		return 0;
	}
	return rms < threshold ? 0 : clamp01(rms);
}

/**
 * One-pole low-pass smoothing toward `raw`. Keeps the previous level (clamped)
 * when `raw` is non-finite so a single bad frame cannot spike the mouth.
 */
export function smoothLevel(previous: number, raw: number, alpha: number = DEFAULT_SMOOTHING_ALPHA): number {
	const factor = Number.isFinite(alpha) && alpha > 0 && alpha <= 1 ? alpha : DEFAULT_SMOOTHING_ALPHA;
	const base = Number.isFinite(previous) ? clamp01(previous) : 0;
	const target = Number.isFinite(raw) ? clamp01(raw) : base;
	return base + factor * (target - base);
}

/**
 * Full per-frame update: RMS -> noise gate -> (silence short-circuits to 0) ->
 * smoothing -> clamp.
 *
 * A frame below the noise gate emits exactly 0, so sustained silence closes the
 * mouth immediately and deterministically; smoothing is applied only to
 * non-silent frames to avoid jitter between words. Feed the samples of the
 * playing node once per RAF.
 */
export function updateAudioLevel(previous: number, samples: Float32Array, options: AudioLevelOptions = {}): number {
	const gated = applyNoiseGate(computeRms(samples), options.noiseGateThreshold);
	if (gated === 0) {
		return 0;
	}
	return clamp01(smoothLevel(previous, gated, options.smoothingAlpha));
}

/**
 * Convenience state holder for a RAF loop. Keeps the smoothed level between
 * frames and always emits a finite 0..1 value. `reset()` zeroes it for a new
 * playback; stale callbacks must not write into a tracker of another playback.
 */
export class AudioLevelTracker {
	#options: AudioLevelOptions;
	level = 0;

	constructor(options: AudioLevelOptions = {}) {
		this.#options = options;
	}

	update(samples: Float32Array): number {
		this.level = updateAudioLevel(this.level, samples, this.#options);
		return this.level;
	}

	reset(): void {
		this.level = 0;
	}
}
