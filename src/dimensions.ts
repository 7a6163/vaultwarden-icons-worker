/**
 * Read an image's pixel dimensions from its header.
 *
 * Sites sometimes declare `sizes="192x192"` on a 32×32 file, so the declared
 * size alone cannot be trusted when ranking candidates (see `getIcon`).
 */

import { sniffImageType } from "./sanitize";

/** Little-endian 24-bit unsigned integer. */
function uint24(view: DataView, offset: number): number {
	return view.getUint16(offset, true) + view.getUint8(offset + 2) * 65_536;
}

/** Largest entry in an ICO directory (a 0 byte means 256). */
function icoSize(view: DataView): number {
	let largest = 0;
	const count = view.getUint16(4, true);
	for (let i = 0; i < count; i += 1) {
		const entry = 6 + i * 16;
		largest = Math.max(
			largest,
			view.getUint8(entry) || 256,
			view.getUint8(entry + 1) || 256,
		);
	}
	return largest;
}

function webpSize(bytes: Uint8Array, view: DataView): number | null {
	const chunk = String.fromCharCode(...bytes.subarray(12, 16));
	if (chunk === "VP8X") {
		return 1 + Math.max(uint24(view, 24), uint24(view, 27));
	}
	if (chunk === "VP8L") {
		const bits = view.getUint32(21, true);
		return 1 + Math.max(bits & 0x3f_ff, (bits >>> 14) & 0x3f_ff);
	}
	if (chunk === "VP8 ") {
		return Math.max(
			view.getUint16(26, true) & 0x3f_ff,
			view.getUint16(28, true) & 0x3f_ff,
		);
	}
	return null;
}

/**
 * Longest pixel edge of a PNG, GIF, ICO or WebP, or null when the format is
 * not one of those or the header is truncated.
 */
export function imageSize(bytes: Uint8Array): number | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	try {
		switch (sniffImageType(bytes)) {
			case "image/png":
				return Math.max(view.getUint32(16), view.getUint32(20));
			case "image/gif":
				return Math.max(view.getUint16(6, true), view.getUint16(8, true));
			case "image/x-icon":
				return icoSize(view);
			case "image/webp":
				return webpSize(bytes, view);
			default:
				return null;
		}
	} catch {
		// DataView throws a RangeError on a header shorter than its fields.
		return null;
	}
}
