/**
 * TASK-030: Embed upload scan 单元测试（spec 13.3 / PD-08 / PD-09）。
 *
 * 纯函数测试：文件名卫生、大小上限、checksum 校验、扩展名/文件头/声明 MIME
 * 一致性（伪造 MIME 拒绝）、媒体类型推导。不依赖 DB/Redis/对象存储。
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { EMBED_MAX_FILE_BYTES, scanUpload, sha256Hex, type UploadScanInput } from "../../src/embed/uploads/scan.ts";

function pngBytes(): Buffer {
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-payload")]);
}

function textBytes(text = "hello world\n"): Buffer {
	return Buffer.from(text, "utf-8");
}

function pdfBytes(): Buffer {
	return Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("payload")]);
}

function scan(overrides: Partial<UploadScanInput> & { data: Buffer; filename: string }): ReturnType<typeof scanUpload> {
	return scanUpload({
		data: overrides.data,
		filename: overrides.filename,
		declaredContentType: overrides.declaredContentType,
		declaredChecksumSha256: overrides.declaredChecksumSha256,
		maxFileBytes: overrides.maxFileBytes,
	});
}

describe("scanUpload", () => {
	test("accepts a valid png with matching extension and declared type", () => {
		const result = scan({ data: pngBytes(), filename: "photo.png", declaredContentType: "image/png" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.mediaType).toBe("image/png");
			expect(result.checksumSha256).toBe(sha256Hex(pngBytes()));
		}
	});

	test("accepts text with derived media type", () => {
		const result = scan({ data: textBytes(), filename: "notes.md", declaredContentType: "text/markdown" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.mediaType).toBe("text/markdown");
	});

	test("accepts json with application/json declared type", () => {
		const result = scan({
			data: textBytes('{"a":1}'),
			filename: "data.json",
			declaredContentType: "application/json",
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.mediaType).toBe("application/json");
	});

	test("accepts pdf", () => {
		const result = scan({ data: pdfBytes(), filename: "doc.pdf", declaredContentType: "application/pdf" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.mediaType).toBe("application/pdf");
	});

	test("rejects forged MIME: text body declared as image/png (extension mismatch first)", () => {
		const result = scan({ data: textBytes(), filename: "photo.png", declaredContentType: "image/png" });
		expect(result).toEqual({ ok: false, reason: "mime_mismatch" });
	});

	test("rejects forged MIME via declared type when extension is neutral", () => {
		const result = scan({ data: textBytes(), filename: "photo", declaredContentType: "image/png" });
		expect(result).toEqual({ ok: false, reason: "declared_type_mismatch" });
	});

	test("rejects extension/magic mismatch: png bytes with .txt", () => {
		const result = scan({ data: pngBytes(), filename: "photo.txt", declaredContentType: "image/png" });
		expect(result).toEqual({ ok: false, reason: "mime_mismatch" });
	});

	test("rejects unknown binary (no magic, not text)", () => {
		const result = scan({ data: Buffer.from([0x00, 0x01, 0x02, 0xff]), filename: "blob.bin" });
		expect(result).toEqual({ ok: false, reason: "unrecognized_file_type" });
	});

	test("rejects empty and oversized files", () => {
		expect(scan({ data: Buffer.alloc(0), filename: "empty.txt" })).toEqual({ ok: false, reason: "empty_file" });
		const big = Buffer.alloc(EMBED_MAX_FILE_BYTES + 1, 0x41);
		expect(scan({ data: big, filename: "big.txt" })).toEqual({ ok: false, reason: "file_too_large" });
		// 测试注入更小的上限。
		expect(scanUpload({ data: Buffer.alloc(1025, 0x41), filename: "big.txt", maxFileBytes: 1024 })).toEqual({
			ok: false,
			reason: "file_too_large",
		});
	});

	test("verifies declared checksum when provided", () => {
		const data = textBytes("checksummed");
		const good = sha256Hex(data);
		expect(scan({ data, filename: "a.txt", declaredChecksumSha256: good }).ok).toBe(true);
		expect(scan({ data, filename: "a.txt", declaredChecksumSha256: "0".repeat(64) })).toEqual({
			ok: false,
			reason: "checksum_mismatch",
		});
		expect(scan({ data, filename: "a.txt", declaredChecksumSha256: "zz" })).toEqual({
			ok: false,
			reason: "invalid_checksum",
		});
	});

	test("rejects unsafe filenames", () => {
		expect(scan({ data: textBytes(), filename: "" })).toEqual({ ok: false, reason: "invalid_filename" });
		expect(scan({ data: textBytes(), filename: ".." })).toEqual({ ok: false, reason: "invalid_filename" });
		expect(scan({ data: textBytes(), filename: "a/b.txt" })).toEqual({ ok: false, reason: "invalid_filename" });
		expect(scan({ data: textBytes(), filename: "a\\b.txt" })).toEqual({ ok: false, reason: "invalid_filename" });
		expect(scan({ data: textBytes(), filename: "a\u0000b.txt" })).toEqual({ ok: false, reason: "invalid_filename" });
		expect(scan({ data: textBytes(), filename: "a".repeat(256) })).toEqual({ ok: false, reason: "invalid_filename" });
	});

	test("sha256Hex matches node crypto", () => {
		expect(sha256Hex(textBytes("x"))).toBe(createHash("sha256").update("x").digest("hex"));
	});
});
