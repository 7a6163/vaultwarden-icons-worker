import { describe, expect, test } from "vitest";
import { sanitizeSvg } from "../src/svg";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("sanitizeSvg", () => {
	test("keeps drawing markup but strips scripting", () => {
		const out = sanitizeSvg(
			enc(
				'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
					"<script>alert(1)</script>" +
					'<rect width="16" height="16" fill="red" onclick="alert(2)"/></svg>',
			),
		);
		if (!out) throw new Error("expected sanitized output");
		const text = dec(out);
		expect(text).toContain("<rect");
		expect(text).not.toContain("<script");
		expect(text).not.toContain("onclick");
	});

	test("strips references to external resources", () => {
		const out = sanitizeSvg(
			enc(
				'<svg xmlns="http://www.w3.org/2000/svg">' +
					'<image href="https://tracker.example/pixel.png"/></svg>',
			),
		);
		expect(dec(out ?? new Uint8Array())).not.toContain("tracker.example");
	});

	test("returns null for input that is not SVG at all", () => {
		expect(sanitizeSvg(enc("<<< not xml"))).toBeNull();
	});

	test("returns null instead of throwing when the WASM call fails", () => {
		// The caller relies on this never throwing, so it can try the next candidate.
		expect(sanitizeSvg(null as unknown as Uint8Array)).toBeNull();
	});
});
