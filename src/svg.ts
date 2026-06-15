/**
 * SVG sanitization via the `svg-hush` WASM module (see ../svg-sanitizer).
 *
 * svg-hush is the same allowlist-based sanitizer Vaultwarden uses internally:
 * it strips scripting and neutralizes external references. We lazily instantiate
 * the WASM module on first use.
 */

import { initSync, sanitize_svg } from "../svg-sanitizer/pkg/svg_sanitizer.js";
// Wrangler/workerd resolve a `.wasm` import to a `WebAssembly.Module` and expose
// it as the default export, which `initSync` accepts.
import wasmModule from "../svg-sanitizer/pkg/svg_sanitizer_bg.wasm";

let initialized = false;

/**
 * Sanitize untrusted SVG bytes. Returns cleaned SVG bytes, or null if the input
 * could not be processed.
 */
export function sanitizeSvg(input: Uint8Array): Uint8Array | null {
	try {
		if (!initialized) {
			initSync({ module: wasmModule });
			initialized = true;
		}
		return sanitize_svg(input) ?? null;
	} catch {
		// Never throw: a WASM failure degrades to "no usable icon" so the caller
		// can fall through to the next candidate (e.g. /favicon.ico).
		return null;
	}
}
