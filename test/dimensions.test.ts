import { describe, expect, test } from "vitest";
import { imageSize } from "../src/dimensions";
import { gif, ico, png, webpLossless, webpLossy, webpExtended } from "./images";

describe("imageSize", () => {
	test("reads PNG dimensions from IHDR, whichever edge is longer", () => {
		expect(imageSize(png(180, 90))).toBe(180);
		expect(imageSize(png(90, 180))).toBe(180);
	});

	test("reads GIF dimensions from the logical screen descriptor", () => {
		expect(imageSize(gif(48, 16))).toBe(48);
		expect(imageSize(gif(16, 48))).toBe(48);
	});

	test("reads the largest entry of an ICO directory", () => {
		expect(imageSize(ico([16, 16], [48, 32], [32, 32]))).toBe(48);
		expect(imageSize(ico([16, 64]))).toBe(64);
	});

	test("treats a 0 width or height in an ICO entry as 256", () => {
		expect(imageSize(ico([0, 16]))).toBe(256);
		expect(imageSize(ico([16, 0]))).toBe(256);
	});

	test("returns 0 for an ICO with no entries", () => {
		expect(imageSize(ico())).toBe(0);
	});

	test("reads extended WebP (VP8X) dimensions, including above 65535", () => {
		expect(imageSize(webpExtended(192, 32))).toBe(192);
		expect(imageSize(webpExtended(32, 192))).toBe(192);
		expect(imageSize(webpExtended(70_000, 1))).toBe(70_000);
		expect(imageSize(webpExtended(1, 70_000))).toBe(70_000);
	});

	test("reads lossless WebP (VP8L) dimensions", () => {
		expect(imageSize(webpLossless(180, 30))).toBe(180);
		expect(imageSize(webpLossless(30, 180))).toBe(180);
	});

	test("reads lossy WebP (VP8) dimensions", () => {
		expect(imageSize(webpLossy(120, 40))).toBe(120);
		expect(imageSize(webpLossy(40, 120))).toBe(120);
	});

	test("returns null for an unknown WebP chunk", () => {
		const bytes = webpLossy(32, 32);
		bytes.set(new TextEncoder().encode("VP8Z"), 12);
		expect(imageSize(bytes)).toBeNull();
	});

	test("returns null for formats it does not parse", () => {
		expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
		expect(imageSize(new TextEncoder().encode("<svg/>"))).toBeNull();
	});

	test("returns null for a truncated header instead of throwing", () => {
		expect(imageSize(png(32, 32).subarray(0, 20))).toBeNull();
		expect(imageSize(ico([16, 16]).subarray(0, 7))).toBeNull();
	});

	test("reads a view that does not start at offset 0 of its buffer", () => {
		const padded = new Uint8Array(64);
		padded.set(png(64, 64), 8);
		expect(imageSize(padded.subarray(8))).toBe(64);
	});
});
