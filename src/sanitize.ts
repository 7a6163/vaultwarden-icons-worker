/**
 * Response-content guards.
 *
 * Raster image bytes are served as-is. SVG is deliberately NOT in the allowlist
 * below: it can carry scripts, so it takes the separate path in `favicon.ts`
 * (sanitized by `svg-hush`, then served behind a strict CSP).
 */

const ALLOWED_IMAGE_TYPES: ReadonlySet<string> = new Set([
	"image/png",
	"image/x-icon",
	"image/vnd.microsoft.icon",
	"image/microsoft.icon",
	"image/jpeg",
	"image/jpg",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/bmp",
]);

/** Lower-cased MIME type from a Content-Type header, parameters stripped. */
export function parseMime(contentType: string | null): string {
	const raw = contentType ?? "";
	const semicolon = raw.indexOf(";");
	return (semicolon === -1 ? raw : raw.slice(0, semicolon))
		.trim()
		.toLowerCase();
}

/** True when the Content-Type is a raster image type we are willing to serve. */
export function isAllowedImageType(contentType: string | null): boolean {
	return ALLOWED_IMAGE_TYPES.has(parseMime(contentType));
}

/**
 * Content-Types that say nothing about the bytes. Favicons are often served
 * this way (S3, CDNs), so these responses are sniffed instead of refused.
 */
const GENERIC_TYPES: ReadonlySet<string> = new Set([
	"",
	"application/octet-stream",
	"binary/octet-stream",
	"text/plain",
]);

/** True when a (parsed) MIME type is generic and the bytes must be sniffed. */
export function isGenericType(mime: string): boolean {
	return GENERIC_TYPES.has(mime);
}

/** Magic numbers, as [offset, bytes] parts that must all match. */
const SIGNATURES: readonly {
	readonly type: string;
	readonly parts: readonly (readonly [number, readonly number[]])[];
}[] = [
	{ type: "image/png", parts: [[0, [0x89, 0x50, 0x4e, 0x47]]] },
	{ type: "image/x-icon", parts: [[0, [0x00, 0x00, 0x01, 0x00]]] },
	{ type: "image/jpeg", parts: [[0, [0xff, 0xd8, 0xff]]] },
	{ type: "image/gif", parts: [[0, [0x47, 0x49, 0x46, 0x38]]] },
	{
		type: "image/webp",
		parts: [
			[0, [0x52, 0x49, 0x46, 0x46]], // "RIFF"
			[8, [0x57, 0x45, 0x42, 0x50]], // "WEBP"
		],
	},
];

/** Raster image type identified from the leading bytes, or null if unrecognized. */
export function sniffImageType(bytes: Uint8Array): string | null {
	const match = SIGNATURES.find((signature) =>
		signature.parts.every(([offset, magic]) =>
			magic.every((byte, i) => bytes[offset + i] === byte),
		),
	);
	return match ? match.type : null;
}
