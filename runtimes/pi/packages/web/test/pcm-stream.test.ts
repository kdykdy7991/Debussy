import { describe, expect, it } from "vitest";
import { PcmDecoder, PcmStreamError, validatePcmFormat } from "../src/features/voice/pcm-stream.ts";

function encodeSamples(samples: number[]): Uint8Array {
	const bytes = new Uint8Array(samples.length * 4);
	const view = new DataView(bytes.buffer);
	samples.forEach((sample, index) => {
		view.setFloat32(index * 4, sample, true);
	});
	return bytes;
}

function decodeAll(bytes: Uint8Array): Float32Array {
	const decoder = new PcmDecoder();
	decoder.push(bytes);
	decoder.end();
	return decoder.take();
}

/** Compares arrays of float32-decoded samples within IEEE-754 representation error. */
function expectSamplesCloseTo(actual: Float32Array, expected: number[]): void {
	expect(actual.length).toBe(expected.length);
	expected.forEach((value, index) => {
		expect(actual[index]).toBeCloseTo(value, 5);
	});
}

const VALID_FORMAT = { encoding: "pcm_f32le", sampleRate: 24000, channels: 1 } as const;

describe("validatePcmFormat", () => {
	it("accepts the agreed pcm_f32le mono format", () => {
		expect(validatePcmFormat(VALID_FORMAT)).toEqual(VALID_FORMAT);
	});

	it("rejects a non-pcm_f32le encoding", () => {
		expect(() => validatePcmFormat({ ...VALID_FORMAT, encoding: "wav" })).toThrowError(PcmStreamError);
		expect(() => validatePcmFormat({ ...VALID_FORMAT, encoding: "wav" })).toThrowError(/encoding/i);
	});

	it("rejects a missing or non-positive sample rate", () => {
		expect(() => validatePcmFormat({ ...VALID_FORMAT, sampleRate: 0 })).toThrowError(/sample rate/i);
		expect(() => validatePcmFormat({ ...VALID_FORMAT, sampleRate: 44.1 })).toThrowError(/sample rate/i);
		expect(() => validatePcmFormat({ ...VALID_FORMAT, sampleRate: Number.NaN })).toThrowError(/sample rate/i);
	});

	it("rejects a non-mono channel count", () => {
		expect(() => validatePcmFormat({ ...VALID_FORMAT, channels: 2 })).toThrowError(/channel/i);
	});
});

describe("PcmDecoder", () => {
	it("decodes a single chunk exactly in little-endian float32", () => {
		const decoded = decodeAll(encodeSamples([1, -1, 0.5, -0.25, 0]));
		expect([...decoded]).toEqual([1, -1, 0.5, -0.25, 0]);
	});

	it("clamps finite out-of-range samples to [-1, 1]", () => {
		const decoded = decodeAll(encodeSamples([2, -2, 1.5, 0.9999]));
		expect([...decoded.slice(0, 3)]).toEqual([1, -1, 1]);
		expectSamplesCloseTo(decoded, [1, -1, 1, 0.9999]);
	});

	it("reassembles a frame split by a 1-byte remainder", () => {
		const bytes = encodeSamples([0.25, -0.5]);
		const decoder = new PcmDecoder();
		decoder.push(bytes.subarray(0, 5));
		decoder.push(bytes.subarray(5));
		expect(decoder.take()).toEqual(new Float32Array([0.25, -0.5]));
		expect(decoder.remainderBytes).toBe(0);
	});

	it("reassembles a frame split by a 2-byte remainder", () => {
		const bytes = encodeSamples([0.25, -0.5]);
		const decoder = new PcmDecoder();
		decoder.push(bytes.subarray(0, 6));
		decoder.push(bytes.subarray(6));
		expect(decoder.take()).toEqual(new Float32Array([0.25, -0.5]));
	});

	it("reassembles a frame split by a 3-byte remainder", () => {
		const bytes = encodeSamples([0.25, -0.5]);
		const decoder = new PcmDecoder();
		decoder.push(bytes.subarray(0, 7));
		decoder.push(bytes.subarray(7));
		expect(decoder.take()).toEqual(new Float32Array([0.25, -0.5]));
	});

	it("reassembles any single split point of an arbitrary sample run", () => {
		const samples = [0.9, -0.3, 0.0, 0.42, -0.77, 1, -1, 0.001];
		const bytes = encodeSamples(samples);
		for (let split = 0; split <= bytes.byteLength; split++) {
			const decoder = new PcmDecoder();
			decoder.push(bytes.subarray(0, split));
			decoder.push(bytes.subarray(split));
			decoder.end();
			expectSamplesCloseTo(decoder.take(), samples);
		}
	});

	it("reassembles audio fragmented into 1/2/3-byte pieces", () => {
		const samples = Array.from({ length: 64 }, (_, index) => (index % 2 === 0 ? 0.5 : -0.5));
		const bytes = encodeSamples(samples);
		const decoder = new PcmDecoder();
		const pattern = [1, 2, 3, 2];
		let offset = 0;
		let piece = 0;
		while (offset < bytes.byteLength) {
			const size = Math.min(pattern[piece++ % pattern.length], bytes.byteLength - offset);
			decoder.push(bytes.subarray(offset, offset + size));
			offset += size;
		}
		decoder.end();
		expect([...decoder.take()]).toEqual(samples);
	});

	it("tolerates an empty chunk", () => {
		const decoder = new PcmDecoder();
		decoder.push(new Uint8Array(0));
		decoder.push(encodeSamples([0.5]));
		decoder.end();
		expect(decoder.take()).toEqual(new Float32Array([0.5]));
	});

	it("queues partial frames until the remainder completes", () => {
		const bytes = encodeSamples([0.25, -0.5, 0.75]);
		const decoder = new PcmDecoder();
		decoder.push(bytes.subarray(0, 9));
		expect(decoder.queuedSamples).toBe(2);
		expect(decoder.remainderBytes).toBe(1);
		decoder.push(bytes.subarray(9));
		expect(decoder.queuedSamples).toBe(3);
		decoder.end();
		expect([...decoder.take()]).toEqual([0.25, -0.5, 0.75]);
	});

	it("take drains incrementally with a limit", () => {
		const decoder = new PcmDecoder();
		decoder.push(encodeSamples([0.1, 0.2, 0.3, 0.4, 0.5]));
		expectSamplesCloseTo(decoder.take(2), [0.1, 0.2]);
		expect(decoder.queuedSamples).toBe(3);
		expectSamplesCloseTo(decoder.take(1), [0.3]);
		expectSamplesCloseTo(decoder.take(), [0.4, 0.5]);
		expect(decoder.queuedSamples).toBe(0);
		expect(decoder.take()).toEqual(new Float32Array(0));
	});

	it("rejects a non-finite sample anywhere in the stream", () => {
		expect(() => new PcmDecoder().push(encodeSamples([0.5, Number.NaN]))).toThrowError(PcmStreamError);
		expect(() => new PcmDecoder().push(encodeSamples([0.5, Number.POSITIVE_INFINITY]))).toThrowError(PcmStreamError);
		expect(() => decodeAll(encodeSamples([0.5, Number.NEGATIVE_INFINITY]))).toThrowError(/finite/i);
	});

	it("fails when EOF leaves a partial frame", () => {
		const decoder = new PcmDecoder();
		decoder.push(encodeSamples([0.5, 0.5]).subarray(0, 6));
		expect(() => decoder.end()).toThrowError(PcmStreamError);
		expect(() => decoder.end()).toThrowError(/truncat/i);
	});

	it("end passes cleanly on a frame-aligned stream", () => {
		const decoder = new PcmDecoder();
		decoder.push(encodeSamples([0.5, 0.5]));
		expect(() => decoder.end()).not.toThrow();
	});
});
