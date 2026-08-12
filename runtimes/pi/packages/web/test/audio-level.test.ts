import { describe, expect, it } from "vitest";
import {
	AudioLevelTracker,
	applyNoiseGate,
	computeRms,
	DEFAULT_NOISE_GATE_THRESHOLD,
	DEFAULT_SMOOTHING_ALPHA,
	smoothLevel,
	updateAudioLevel,
} from "../src/features/avatar/audio-level.ts";

function buffer(...samples: number[]): Float32Array {
	return Float32Array.from(samples);
}

const LOUD = buffer(1, 1, 1, 1);
const SILENCE = buffer(0, 0, 0, 0);

describe("computeRms", () => {
	it("is zero for silence", () => {
		expect(computeRms(SILENCE)).toBe(0);
	});

	it("is 1 for a full-scale sample", () => {
		expect(computeRms(buffer(1))).toBe(1);
		expect(computeRms(buffer(-1))).toBe(1);
	});

	it("computes RMS of known samples", () => {
		expect(computeRms(buffer(0.5, -0.5))).toBeCloseTo(0.5, 5);
		expect(computeRms(buffer(0, 0, 0.3))).toBeCloseTo(Math.sqrt(0.03), 5);
	});

	it("returns 0 for an empty buffer", () => {
		expect(computeRms(new Float32Array(0))).toBe(0);
	});

	it("rejects non-finite samples", () => {
		expect(computeRms(buffer(NaN, Infinity, -Infinity))).toBe(0);
		expect(computeRms(buffer(0.5, NaN))).toBeCloseTo(Math.sqrt(0.125), 5);
	});

	it("clamps out-of-range samples to [-1, 1] before squaring", () => {
		expect(computeRms(buffer(2, -3))).toBe(1);
	});
});

describe("applyNoiseGate", () => {
	it("zeroes values below the threshold", () => {
		expect(applyNoiseGate(0.001)).toBe(0);
		expect(applyNoiseGate(DEFAULT_NOISE_GATE_THRESHOLD - 0.000001)).toBe(0);
	});

	it("keeps values at or above the threshold", () => {
		expect(applyNoiseGate(0.01)).toBeCloseTo(0.01, 5);
		expect(applyNoiseGate(0.004)).toBeCloseTo(0.004, 5);
		expect(applyNoiseGate(0.005, 0.004)).toBeCloseTo(0.005, 5);
	});

	it("clamps to [0, 1]", () => {
		expect(applyNoiseGate(1.5)).toBe(1);
		expect(applyNoiseGate(-0.1)).toBe(0);
	});

	it("maps non-finite input to 0", () => {
		expect(applyNoiseGate(NaN)).toBe(0);
		expect(applyNoiseGate(Infinity)).toBe(0);
	});
});

describe("smoothLevel", () => {
	it("applies the default one-pole smoothing factor", () => {
		expect(smoothLevel(0, 1)).toBeCloseTo(0.3, 5);
		expect(smoothLevel(1, 0)).toBeCloseTo(0.7, 5);
		expect(smoothLevel(0.5, 0.5)).toBe(0.5);
	});

	it("honors a custom alpha in (0, 1]", () => {
		expect(smoothLevel(0, 1, 1)).toBe(1);
		expect(smoothLevel(0, 1, 0.5)).toBe(0.5);
	});

	it("falls back to the default for an invalid alpha", () => {
		expect(smoothLevel(0, 1, 2)).toBeCloseTo(0.3, 5);
		expect(smoothLevel(0, 1, 0)).toBeCloseTo(0.3, 5);
		expect(smoothLevel(0, 1, NaN)).toBeCloseTo(0.3, 5);
	});

	it("never lets a non-finite frame spike the output", () => {
		expect(smoothLevel(0.5, NaN)).toBe(0.5);
		expect(smoothLevel(NaN, 0)).toBe(0);
	});

	it("clamps the target to [0, 1]", () => {
		expect(smoothLevel(0, 2)).toBeCloseTo(DEFAULT_SMOOTHING_ALPHA, 5);
	});
});

describe("updateAudioLevel", () => {
	it("emits 0 for a silent frame", () => {
		expect(updateAudioLevel(0, SILENCE)).toBe(0);
		expect(updateAudioLevel(1, SILENCE)).toBe(0);
	});

	it("attacks from 0 with a loud frame", () => {
		expect(updateAudioLevel(0, LOUD)).toBeCloseTo(0.3, 5);
		expect(updateAudioLevel(0.3, LOUD)).toBeCloseTo(0.3 + 0.3 * 0.7, 5);
	});

	it("treats a non-finite buffer as silence", () => {
		expect(updateAudioLevel(0.8, buffer(NaN))).toBe(0);
	});
});

describe("AudioLevelTracker", () => {
	it("starts at 0 and stays finite", () => {
		const tracker = new AudioLevelTracker();
		expect(tracker.level).toBe(0);
		expect(updateAudioLevel(0, LOUD)).toBe(tracker.update(LOUD));
	});

	it("tracks per-frame levels and closes on silence", () => {
		const tracker = new AudioLevelTracker();
		tracker.update(LOUD);
		expect(tracker.level).toBeCloseTo(0.3, 5);
		tracker.update(SILENCE);
		expect(tracker.level).toBe(0);
	});

	it("reset zeroes the level for a new playback", () => {
		const tracker = new AudioLevelTracker();
		tracker.update(LOUD);
		tracker.reset();
		expect(tracker.level).toBe(0);
	});

	it("converges from a loud level toward a quieter target", () => {
		const tracker = new AudioLevelTracker();
		tracker.level = 1;
		const next = tracker.update(buffer(0.5));
		expect(next).toBeCloseTo(0.85, 5);
	});
});
