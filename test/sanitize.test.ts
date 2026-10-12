import { describe, expect, test } from "vitest";
import {
	isAllowedImageType,
	isGenericType,
	parseMime,
	sniffImageType,
} from "../src/sanitize";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("isGenericType", () => {
	test("flags content types that say nothing about the bytes", () => {
		for (const mime of [
			"",
			"application/octet-stream",
			"binary/octet-stream",
			"text/plain",
		]) {
			expect(isGenericType(mime)).toBe(true);
		}
	});

	test("does not flag specific types", () => {
		expect(isGenericType("image/png")).toBe(false);
		expect(isGenericType("text/html")).toBe(false);
	});
});

describe("sniffImageType", () => {
	test("recognizes each supported magic number", () => {
		expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe(
			"image/png",
		);
		expect(sniffImageType(bytes(0x00, 0x00, 0x01, 0x00, 0x01))).toBe(
			"image/x-icon",
		);
		expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
		expect(sniffImageType(new TextEncoder().encode("GIF89a"))).toBe(
			"image/gif",
		);
		expect(
			sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")),
		).toBe("image/webp");
	});

	test("requires every byte of the signature to match", () => {
		expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x00))).toBeNull();
		expect(sniffImageType(bytes(0x00, 0x00, 0x02, 0x00))).toBeNull();
		// RIFF container that is not WebP (e.g. WAV).
		expect(
			sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WAVE")),
		).toBeNull();
	});

	test("returns null for text or truncated input", () => {
		expect(sniffImageType(new TextEncoder().encode("<html>"))).toBeNull();
		expect(sniffImageType(bytes(0x89))).toBeNull();
		expect(sniffImageType(bytes())).toBeNull();
	});
});

describe("isAllowedImageType", () => {
	test("accepts common raster favicon types", () => {
		for (const ct of [
			"image/png",
			"image/x-icon",
			"image/vnd.microsoft.icon",
			"image/jpeg",
			"image/gif",
			"image/webp",
			"image/avif",
		]) {
			expect(isAllowedImageType(ct)).toBe(true);
		}
	});

	test("ignores charset and other parameters", () => {
		expect(isAllowedImageType("image/png; charset=binary")).toBe(true);
		expect(isAllowedImageType("IMAGE/PNG")).toBe(true);
	});

	test("excludes SVG, which takes the sanitizing path instead", () => {
		expect(isAllowedImageType("image/svg+xml")).toBe(false);
		expect(isAllowedImageType("image/svg+xml; charset=utf-8")).toBe(false);
	});

	test("rejects non-image and empty content types", () => {
		expect(isAllowedImageType("text/html")).toBe(false);
		expect(isAllowedImageType("application/json")).toBe(false);
		expect(isAllowedImageType("")).toBe(false);
		expect(isAllowedImageType(null)).toBe(false);
	});
});

describe("parseMime", () => {
	test("strips parameters and normalizes case", () => {
		expect(parseMime("image/PNG; charset=binary")).toBe("image/png");
		expect(parseMime("  image/png  ")).toBe("image/png");
	});

	test("returns an empty string for a missing header", () => {
		expect(parseMime(null)).toBe("");
		expect(parseMime("")).toBe("");
	});
});
