/**
 * Favicon discovery and retrieval.
 *
 * The Worker fetches a site's HTML, extracts `<link rel="icon">` candidates with
 * HTMLRewriter (the native streaming parser — no dependencies), and falls back
 * to `/favicon.ico`. Every candidate is re-validated against the SSRF guard and
 * content checks before its bytes are returned. No third party is involved.
 */

import { isAllowedImageType, parseMime } from "./sanitize";
import { isPublicHostname, type ParsedDomain } from "./ssrf";
import { sanitizeSvg } from "./svg";

export interface IconFetchOptions {
	/** Reject any response whose body exceeds this many bytes. */
	readonly maxBytes: number;
	/** Per-request outbound timeout. */
	readonly timeoutMs: number;
	/**
	 * Optional third-party icon URL template (one `{}` placeholder for the host).
	 * Fetched server-side only when own discovery fails. Null/undefined disables it.
	 */
	readonly fallbackUrl?: string | null;
	/** Operator-blocked hostname suffixes, enforced on every outbound URL and redirect hop. */
	readonly blockedSuffixes?: readonly string[];
}

export interface IconResult {
	readonly body: ArrayBuffer;
	readonly contentType: string;
}

interface IconCandidate {
	readonly href: string;
	readonly size: number;
}

const ICON_RELS: ReadonlySet<string> = new Set([
	"icon",
	"shortcut",
	"apple-touch-icon",
	"apple-touch-icon-precomposed",
	"mask-icon",
	"fluid-icon",
]);

const USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const ACCEPT_IMAGE = "image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5";
const ACCEPT_HTML =
	"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/** Max discovered candidates to attempt before giving up (bounds outbound fan-out). */
const MAX_CANDIDATES = 5;

/** Max <link> icon candidates to collect from a page (bounds memory on hostile HTML). */
const MAX_DISCOVERED_LINKS = 50;

/** Max homepage bytes fed to the HTML parser (icon links live in <head>). */
const MAX_HTML_BYTES = 1_048_576;

/** Max redirect hops followed per outbound request. */
const MAX_REDIRECTS = 5;

/**
 * Fetch with a single timeout across all hops. Redirects are followed manually
 * so every Location is re-validated against the SSRF guard — `redirect: "follow"`
 * would let a public site bounce the Worker to a blocked or internal host.
 * Throws when a redirect is refused or the hop limit is exceeded.
 */
async function timedFetch(
	url: string,
	accept: string,
	options: IconFetchOptions,
): Promise<Response> {
	const signal = AbortSignal.timeout(options.timeoutMs);
	let current = url;
	for (let hop = 0; ; hop += 1) {
		const response = await fetch(current, {
			redirect: "manual",
			signal,
			headers: { "user-agent": USER_AGENT, accept },
		});
		const location = response.headers.get("location");
		if (response.status < 300 || response.status >= 400 || !location) {
			return response;
		}
		await drain(response);
		const next = toFetchableUrl(location, current, options.blockedSuffixes);
		if (!next || hop >= MAX_REDIRECTS) {
			throw new Error("redirect refused");
		}
		current = next;
	}
}

async function drain(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// best effort
	}
}

/**
 * Read a response body into an ArrayBuffer, aborting as soon as it exceeds
 * `maxBytes`. Avoids buffering an entire over-large (or content-length-lying)
 * response into memory. Returns null on overflow or stream error.
 */
export async function readCapped(
	response: Response,
	maxBytes: number,
): Promise<ArrayBuffer | null> {
	if (!response.body) {
		return null;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} catch {
		return null;
	}

	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out.buffer;
}

function parseSize(sizes: string | null): number {
	if (!sizes) {
		return 0;
	}
	const match = /(\d+)/.exec(sizes);
	return match ? Number(match[1]) : 0;
}

/** Resolve an href or Location to an absolute, fetchable, public http(s) URL — or null. */
function toFetchableUrl(
	href: string,
	base: string,
	blockedSuffixes?: readonly string[],
): string | null {
	let url: URL;
	try {
		url = new URL(href, base);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return null;
	}
	if (!isPublicHostname(url.hostname, blockedSuffixes)) {
		return null;
	}
	return url.toString();
}

/**
 * Extract icon `<link>` candidates from an HTML response. Parsing stops at
 * `<body>` or after MAX_HTML_BYTES, so a huge or endless page cannot exhaust
 * memory. Returns [] if the body can't be read.
 */
export async function collectIconLinks(
	htmlResponse: Response,
): Promise<IconCandidate[]> {
	const candidates: IconCandidate[] = [];
	let reachedBody = false;
	const rewriter = new HTMLRewriter()
		.on("body", {
			element() {
				reachedBody = true;
			},
		})
		.on("link", {
			element(el) {
				const rel = (el.getAttribute("rel") ?? "").toLowerCase();
				const isIcon = rel.split(/\s+/).some((token) => ICON_RELS.has(token));
				if (!isIcon) {
					return;
				}
				const href = el.getAttribute("href");
				if (href && candidates.length < MAX_DISCOVERED_LINKS) {
					candidates.push({ href, size: parseSize(el.getAttribute("sizes")) });
				}
			},
		});

	try {
		// Consuming the transformed body is what drives the rewriter.
		const body = rewriter.transform(htmlResponse).body;
		if (!body) {
			return candidates;
		}
		const reader = body.getReader();
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.byteLength;
			// Just stop pulling: backpressure halts the upstream read, and the
			// connection closes with the request. Cancelling the rewriter's output
			// instead leaves an unhandled "Stream was cancelled" in the runtime.
			if (reachedBody || total > MAX_HTML_BYTES) {
				break;
			}
		}
	} catch {
		// Unreadable body: degrade to /favicon.ico rather than failing the request.
		await drain(htmlResponse);
		return [];
	}
	return candidates;
}

async function discoverCandidateUrls(
	domain: ParsedDomain,
	options: IconFetchOptions,
): Promise<string[]> {
	let html: Response;
	try {
		html = await timedFetch(`${domain.origin}/`, ACCEPT_HTML, options);
	} catch {
		return [];
	}

	const contentType = html.headers.get("content-type") ?? "";
	if (!html.ok || !contentType.includes("html")) {
		await drain(html);
		return [];
	}

	const links = await collectIconLinks(html);
	return links
		.toSorted((a, b) => b.size - a.size)
		.map((candidate) =>
			toFetchableUrl(candidate.href, domain.origin, options.blockedSuffixes),
		)
		.filter((url): url is string => url !== null);
}

async function fetchIcon(
	url: string,
	options: IconFetchOptions,
): Promise<IconResult | null> {
	let response: Response;
	try {
		response = await timedFetch(url, ACCEPT_IMAGE, options);
	} catch {
		return null;
	}

	const contentType = response.headers.get("content-type");
	const mime = parseMime(contentType);
	const isSvg = mime === "image/svg+xml";
	if (!response.ok || (!isAllowedImageType(contentType) && !isSvg)) {
		await drain(response);
		return null;
	}

	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
		await drain(response);
		return null;
	}

	const body = await readCapped(response, options.maxBytes);
	if (!body || body.byteLength === 0) {
		return null;
	}

	if (isSvg) {
		const cleaned = sanitizeSvg(new Uint8Array(body));
		if (!cleaned || cleaned.byteLength === 0) {
			return null;
		}
		return {
			body: cleaned.buffer as ArrayBuffer,
			contentType: "image/svg+xml",
		};
	}

	return { body, contentType: mime };
}

/**
 * Resolve and return the best available favicon for a domain, or null if none
 * could be retrieved. Tries declared `<link>` icons (largest first) then
 * `/favicon.ico`.
 */
export async function getIcon(
	domain: ParsedDomain,
	options: IconFetchOptions,
): Promise<IconResult | null> {
	const discovered = await discoverCandidateUrls(domain, options);
	const ordered = [...discovered, `${domain.origin}/favicon.ico`];

	const seen = new Set<string>();
	let attempts = 0;
	for (const url of ordered) {
		if (seen.has(url) || attempts >= MAX_CANDIDATES + 1) {
			continue;
		}
		seen.add(url);
		attempts += 1;

		const icon = await fetchIcon(url, options);
		if (icon) {
			return icon;
		}
	}

	// Own discovery failed: optionally fall back to an operator-configured
	// third-party icon service, fetched server-side (the client is never exposed).
	if (options.fallbackUrl) {
		const fallback = options.fallbackUrl.replace(
			"{}",
			encodeURIComponent(domain.host),
		);
		const icon = await fetchIcon(fallback, options);
		if (icon) {
			return icon;
		}
	}

	return null;
}
