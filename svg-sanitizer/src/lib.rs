//! WASM wrapper around `svg-hush` — the same allowlist-based SVG sanitizer
//! Vaultwarden uses in its internal icon path.
//!
//! Exposes a single function to JavaScript:
//!   `sanitize_svg(input: Uint8Array) -> Uint8Array | undefined`
//!
//! It strips scripting (`<script>`, `on*` handlers, `javascript:` URLs),
//! neutralizes external references, and returns sanitized SVG bytes — or
//! `undefined` if the input could not be processed.

use svg_hush::{data_url_filter, Filter};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn sanitize_svg(input: &[u8]) -> Option<Vec<u8>> {
    let mut filter = Filter::new();
    // Allow inline data: image URLs (e.g. embedded PNGs) but drop external refs.
    filter.set_data_url_filter(data_url_filter::allow_standard_images);

    let mut out = Vec::new();
    match filter.filter(input, &mut out) {
        Ok(()) => Some(out),
        Err(_) => None,
    }
}
