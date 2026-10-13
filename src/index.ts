/**
 * vaultwarden-icons — Cloudflare Worker icon service for Vaultwarden.
 *
 * Vaultwarden is pointed at this Worker via `ICON_SERVICE=https://<host>/{}`.
 * It responds to clients with a redirect to `/<domain>`, and this Worker fetches
 * the favicon server-side and returns the bytes — so the target site only ever
 * sees Cloudflare's IP, never the Vaultwarden server or the end client.
 */

import { type FetchTrace, getIcon, type IconFetchOptions } from "./favicon";
import { isPublicHostname, parseDomain } from "./ssrf";

export interface Env {
	readonly BLOCKED_SUFFIXES?: string;
	readonly MAX_ICON_BYTES?: string;
	readonly FETCH_TIMEOUT_MS?: string;
	readonly CACHE_TTL_SECONDS?: string;
	readonly FALLBACK_ICON_SERVICE?: string;
}

/** Presets for the optional third-party fallback (off by default). */
const FALLBACK_PRESETS: Readonly<Record<string, string>> = {
	duckduckgo: "https://icons.duckduckgo.com/ip3/{}.ico",
	google: "https://www.google.com/s2/favicons?domain={}&sz=64",
	bitwarden: "https://icons.bitwarden.net/{}/icon.png",
};

/** Resolve FALLBACK_ICON_SERVICE to a URL template, or null when disabled/invalid. */
export function resolveFallbackUrl(value: string | undefined): string | null {
	const raw = (value ?? "").trim();
	if (!raw) {
		return null;
	}
	const preset = FALLBACK_PRESETS[raw.toLowerCase()];
	if (preset) {
		return preset;
	}
	return raw.startsWith("https://") && raw.includes("{}") ? raw : null;
}

export interface ResolvedConfig extends IconFetchOptions {
	readonly cacheTtl: number;
	readonly negativeTtl: number;
	/** TTL for a miss caused by a timeout, network error, 5xx or 429. */
	readonly transientTtl: number;
	readonly blockedSuffixes: readonly string[];
}

const DEFAULTS = {
	maxBytes: 524_288,
	timeoutMs: 5_000,
	cacheTtl: 604_800, // 7 days
	maxNegativeTtl: 86_400, // 1 day for fallbacks
	maxTransientTtl: 300, // 5 minutes when the site may just be briefly down
} as const;

function positiveInt(value: string | undefined, fallback: number): number {
	// Floor before the range check, or "0.5" would pass and become 0.
	const parsed = Math.floor(Number(value));
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

export function resolveConfig(env: Env): ResolvedConfig {
	const cacheTtl = positiveInt(env.CACHE_TTL_SECONDS, DEFAULTS.cacheTtl);
	const negativeTtl = Math.min(cacheTtl, DEFAULTS.maxNegativeTtl);
	return {
		maxBytes: positiveInt(env.MAX_ICON_BYTES, DEFAULTS.maxBytes),
		timeoutMs: positiveInt(env.FETCH_TIMEOUT_MS, DEFAULTS.timeoutMs),
		cacheTtl,
		negativeTtl,
		transientTtl: Math.min(negativeTtl, DEFAULTS.maxTransientTtl),
		blockedSuffixes: (env.BLOCKED_SUFFIXES ?? "")
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean),
		fallbackUrl: resolveFallbackUrl(env.FALLBACK_ICON_SERVICE),
	};
}

function imageResponse(
	body: BodyInit,
	contentType: string,
	maxAge: number,
	status: "hit" | "miss" | "fallback",
): Response {
	const headers: Record<string, string> = {
		"content-type": contentType,
		"cache-control": `public, max-age=${maxAge}`,
		"x-content-type-options": "nosniff",
		"access-control-allow-origin": "*",
		"x-icon-result": status,
	};
	if (contentType === "image/svg+xml") {
		// Defense in depth on top of svg-hush: block any script execution or
		// external loads even if the SVG is opened as a top-level document.
		headers["content-security-policy"] =
			"default-src 'none'; style-src 'unsafe-inline'; sandbox";
	}
	return new Response(body, { status: 200, headers });
}

function notFoundResponse(negativeTtl: number): Response {
	// No icon available: respond 404 (cacheable) so each client renders its own
	// built-in placeholder, instead of a foreign or blank image.
	return new Response(null, {
		status: 404,
		headers: {
			"cache-control": `public, max-age=${negativeTtl}`,
			"access-control-allow-origin": "*",
			"x-icon-result": "none",
		},
	});
}

async function handleIcon(
	url: URL,
	config: ResolvedConfig,
	ctx: ExecutionContext,
): Promise<Response> {
	const domain = parseDomain(url.pathname);
	if (!domain || !isPublicHostname(domain.host, config.blockedSuffixes)) {
		// Don't cache rejections of arbitrary input at the edge.
		return notFoundResponse(config.negativeTtl);
	}

	// Key on the normalized target, not the raw path: /GitHub.com, /github.com/
	// and /github.com/<junk> resolve to the same icon and must share one entry,
	// or a random suffix would bypass the cache and fan out upstream every time.
	const cacheKey = new Request(`${url.origin}/${new URL(domain.origin).host}`);
	const cache = caches.default;
	const cached = await cache.match(cacheKey);
	if (cached) {
		if (cached.status !== 200) {
			return cached;
		}
		const hit = new Response(cached.body, cached);
		hit.headers.set("x-icon-result", "hit");
		return hit;
	}

	const trace: FetchTrace = { transient: false };
	const icon = await getIcon(domain, config, trace);
	if (!icon) {
		const miss = notFoundResponse(
			trace.transient ? config.transientTtl : config.negativeTtl,
		);
		ctx.waitUntil(cache.put(cacheKey, miss.clone()));
		return miss;
	}

	const response = imageResponse(
		icon.body,
		icon.contentType,
		config.cacheTtl,
		icon.source === "fallback" ? "fallback" : "miss",
	);
	ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method Not Allowed", {
				status: 405,
				headers: { allow: "GET, HEAD" },
			});
		}

		const url = new URL(request.url);
		const config = resolveConfig(env);

		if (url.pathname === "/" || url.pathname === "/healthz") {
			return new Response("vaultwarden-icons: ok", {
				status: 200,
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}

		// Browsers auto-request the Worker's own favicon; we have none, so 404.
		if (url.pathname === "/favicon.ico") {
			return notFoundResponse(config.negativeTtl);
		}

		try {
			const response = await handleIcon(url, config, ctx);

			if (request.method === "HEAD") {
				return new Response(null, {
					status: response.status,
					headers: response.headers,
				});
			}
			return response;
		} catch {
			// Never surface a 500 — a 404 lets the client show its own placeholder.
			return notFoundResponse(config.negativeTtl);
		}
	},
} satisfies ExportedHandler<Env>;
