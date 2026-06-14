/**
 * Bundled fallback icon, served when no real favicon can be retrieved.
 *
 * A 1x1 transparent PNG keeps clients happy (a valid image) without inventing a
 * branded placeholder. Mirrors Vaultwarden's own fallback-icon behaviour.
 */

const FALLBACK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export const FALLBACK_ICON: Uint8Array = decodeBase64(FALLBACK_PNG_BASE64);
export const FALLBACK_CONTENT_TYPE = "image/png";
