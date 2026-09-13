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
