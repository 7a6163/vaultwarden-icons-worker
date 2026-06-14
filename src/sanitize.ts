/**
 * Response-content guards.
 *
 * We only ever serve raster image bytes. SVG is deliberately excluded: it can
 * carry scripts, and serving it from a trusted origin would create an XSS
 * vector in clients that render it inline.
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

/** True when the Content-Type is a raster image type we are willing to serve. */
export function isAllowedImageType(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_IMAGE_TYPES.has(mime);
}
