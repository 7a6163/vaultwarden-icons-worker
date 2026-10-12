/**
 * Favicon discovery and retrieval.
 *
 * The Worker fetches a site's HTML, extracts `<link rel="icon">` candidates with
 * HTMLRewriter (the native streaming parser — no dependencies), and falls back
 * to `/favicon.ico`. Every candidate is re-validated against the SSRF guard and
 * content checks before its bytes are returned. No third party is involved.
 */

import {
	isAllowedImageType,
	isGenericType,
	parseMime,
	sniffImageType,
} from "./sanitize";
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

interface IconBytes {
	readonly body: ArrayBuffer;
	readonly contentType: string;
}

export interface IconResult extends IconBytes {
	/** Whether the icon came from the site itself or the third-party fallback. */
	readonly source: "site" | "fallback";
}

/**
 * Filled in by getIcon: whether any upstream failure looked transient (network
 * error, timeout, 5xx, 429), so a miss can be cached briefly instead of for a day.
 */
export interface FetchTrace {
	transient: boolean;
}

interface IconCandidate {
	readonly href: string;
	readonly size: number;
}

export interface IconLinks {
	/** The first `<base href>`, if the page declared one. */
	readonly base: string | null;
	readonly links: IconCandidate[];
}

/** Per-lookup state shared by every outbound request. */
interface Lookup {
	readonly options: IconFetchOptions;
	readonly trace: FetchTrace;
	/** Aborts every outbound request once the whole lookup's time budget is spent. */
	readonly deadline: AbortSignal;
}

interface Fetched {
	readonly response: Response;
	/** Final URL after redirects; relative hrefs resolve against it. */
	readonly url: string;
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

/** Whole-lookup time budget, in multiples of the per-request timeout. */
const LOOKUP_BUDGET_TIMEOUTS = 2;

/**
 * Fetch with a single timeout across all hops (and the lookup's overall
 * deadline). Redirects are followed manually so every Location is re-validated
 * against the SSRF guard — `redirect: "follow"` would let a public site bounce
 * the Worker to a blocked or internal host. Throws when a redirect is refused,
 * the hop limit is exceeded, or the request fails.
 */
async function timedFetch(
	url: string,
	accept: string,
	lookup: Lookup,
): Promise<Fetched> {
	const signal = AbortSignal.any([
		AbortSignal.timeout(lookup.options.timeoutMs),
		lookup.deadline,
	]);
	let current = url;
	for (let hop = 0; ; hop += 1) {
		let response: Response;
		try {
			response = await fetch(current, {
				redirect: "manual",
				signal,
				headers: { "user-agent": USER_AGENT, accept },
			});
		} catch (error) {
			lookup.trace.transient = true;
			throw error;
		}
		if (response.status >= 500 || response.status === 429) {
			lookup.trace.transient = true;
		}
		const location = response.headers.get("location");
		if (response.status < 300 || response.status >= 400 || !location) {
			return { response, url: current };
		}
		await drain(response);
		const next = toFetchableUrl(
			location,
			current,
			lookup.options.blockedSuffixes,
		);
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

/** Largest edge across every `WxH` in a `sizes` attribute; 0 for "any" or junk. */
function parseSize(sizes: string | null): number {
	let largest = 0;
	for (const match of (sizes ?? "").matchAll(/(\d+)x(\d+)/gi)) {
		largest = Math.max(largest, Number(match[1]), Number(match[2]));
	}
	return largest;
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
 * Extract icon `<link>` candidates (and any `<base href>`) from an HTML
 * response. Parsing stops at `<body>` or after MAX_HTML_BYTES, so a huge or
 * endless page cannot exhaust memory. Returns no links if the body can't be read.
 */
export async function collectIconLinks(
	htmlResponse: Response,
): Promise<IconLinks> {
	const candidates: IconCandidate[] = [];
	let base: string | null = null;
	let reachedBody = false;
	const rewriter = new HTMLRewriter()
		.on("body", {
			element() {
				reachedBody = true;
			},
		})
		.on("base", {
			element(el) {
				base ??= el.getAttribute("href");
			},
		})
		.on("link", {
			element(el) {
				const tokens = (el.getAttribute("rel") ?? "")
					.toLowerCase()
					.split(/\s+/);
				if (!tokens.some((token) => ICON_RELS.has(token))) {
					return;
				}
				const href = el.getAttribute("href");
				if (href && candidates.length < MAX_DISCOVERED_LINKS) {
					// mask-icon is Safari's single-colour pinned-tab glyph: a last resort.
					const size = tokens.includes("mask-icon")
						? -1
						: parseSize(el.getAttribute("sizes"));
					candidates.push({ href, size });
				}
			},
		});

	try {
		// Consuming the transformed body is what drives the rewriter.
		const body = rewriter.transform(htmlResponse).body;
		if (!body) {
			return { base, links: candidates };
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
		return { base: null, links: [] };
	}
	return { base, links: candidates };
}

/** Resolve a `<base href>` against the page URL; an unusable one is ignored. */
function resolveBase(base: string | null, pageUrl: string): string {
	if (!base) {
		return pageUrl;
	}
	try {
		return new URL(base, pageUrl).toString();
	} catch {
		return pageUrl;
	}
}

async function discoverCandidateUrls(
	domain: ParsedDomain,
	lookup: Lookup,
): Promise<string[]> {
	let page: Fetched;
	try {
		page = await timedFetch(`${domain.origin}/`, ACCEPT_HTML, lookup);
	} catch {
		return [];
	}
	const html = page.response;

	const contentType = html.headers.get("content-type") ?? "";
	if (!html.ok || !contentType.includes("html")) {
		await drain(html);
		return [];
	}

	// Relative hrefs resolve against the final page URL (after redirects) or
	// the page's <base href>, as a browser would.
	const { base, links } = await collectIconLinks(html);
	const baseUrl = resolveBase(base, page.url);
	return links
		.toSorted((a, b) => b.size - a.size)
		.map((candidate) =>
			toFetchableUrl(candidate.href, baseUrl, lookup.options.blockedSuffixes),
		)
		.filter((url): url is string => url !== null);
}

async function fetchIcon(
	url: string,
	lookup: Lookup,
): Promise<IconBytes | null> {
	const { options } = lookup;
	let response: Response;
	try {
		({ response } = await timedFetch(url, ACCEPT_IMAGE, lookup));
	} catch {
		return null;
	}

	const contentType = response.headers.get("content-type");
	const mime = parseMime(contentType);
	const isSvg = mime === "image/svg+xml";
	const mustSniff = isGenericType(mime);
	if (
		!response.ok ||
		(!isAllowedImageType(contentType) && !isSvg && !mustSniff)
	) {
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

	const type = mustSniff ? sniffImageType(new Uint8Array(body)) : mime;
	return type ? { body, contentType: type } : null;
}

/**
 * Resolve and return the best available favicon for a domain, or null if none
 * could be retrieved. Tries declared `<link>` icons (largest first, at most
 * MAX_CANDIDATES) then `/favicon.ico`. The whole lookup shares a time budget.
 */
export async function getIcon(
	domain: ParsedDomain,
	options: IconFetchOptions,
	trace: FetchTrace = { transient: false },
): Promise<IconResult | null> {
	const lookup: Lookup = {
		options,
		trace,
		deadline: AbortSignal.timeout(options.timeoutMs * LOOKUP_BUDGET_TIMEOUTS),
	};
	const discovered = await discoverCandidateUrls(domain, lookup);
	// Cap the declared links but always leave a slot for /favicon.ico.
	const ordered = new Set([
		...[...new Set(discovered)].slice(0, MAX_CANDIDATES),
		`${domain.origin}/favicon.ico`,
	]);

	for (const url of ordered) {
		const icon = await fetchIcon(url, lookup);
		if (icon) {
			return { ...icon, source: "site" };
		}
	}

	// Own discovery failed: optionally fall back to an operator-configured
	// third-party icon service, fetched server-side (the client is never exposed).
	if (options.fallbackUrl) {
		const fallback = options.fallbackUrl.replace(
			"{}",
			encodeURIComponent(domain.host),
		);
		const icon = await fetchIcon(fallback, lookup);
		if (icon) {
			return { ...icon, source: "fallback" };
		}
	}

	return null;
}
