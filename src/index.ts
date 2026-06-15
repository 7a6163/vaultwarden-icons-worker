/**
 * vaultwarden-icons — Cloudflare Worker icon service for Vaultwarden.
 *
 * Vaultwarden is pointed at this Worker via `ICON_SERVICE=https://<host>/{}`.
 * It responds to clients with a redirect to `/<domain>`, and this Worker fetches
 * the favicon server-side and returns the bytes — so the target site only ever
 * sees Cloudflare's IP, never the Vaultwarden server or the end client.
 */

import { getIcon, type IconFetchOptions } from "./favicon";
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
function resolveFallbackUrl(value: string | undefined): string | null {
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

interface ResolvedConfig extends IconFetchOptions {
	readonly cacheTtl: number;
	readonly negativeTtl: number;
	readonly blockedSuffixes: readonly string[];
}

const DEFAULTS = {
	maxBytes: 524_288,
	timeoutMs: 5_000,
	cacheTtl: 604_800, // 7 days
	maxNegativeTtl: 86_400, // 1 day for fallbacks
} as const;

function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function resolveConfig(env: Env): ResolvedConfig {
	const cacheTtl = positiveInt(env.CACHE_TTL_SECONDS, DEFAULTS.cacheTtl);
	return {
		maxBytes: positiveInt(env.MAX_ICON_BYTES, DEFAULTS.maxBytes),
		timeoutMs: positiveInt(env.FETCH_TIMEOUT_MS, DEFAULTS.timeoutMs),
		cacheTtl,
		negativeTtl: Math.min(cacheTtl, DEFAULTS.maxNegativeTtl),
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
	pathname: string,
	config: ResolvedConfig,
	ctx: ExecutionContext,
	cacheKey: Request,
): Promise<Response> {
	const cache = caches.default;
	const cached = await cache.match(cacheKey);
	if (cached) {
		return cached;
	}

	const domain = parseDomain(pathname);
	if (!domain || !isPublicHostname(domain.host, config.blockedSuffixes)) {
		// Don't cache rejections of arbitrary input at the edge.
		return notFoundResponse(config.negativeTtl);
	}

	const icon = await getIcon(domain, config);
	if (!icon) {
		const miss = notFoundResponse(config.negativeTtl);
		ctx.waitUntil(cache.put(cacheKey, miss.clone()));
		return miss;
	}

	const response = imageResponse(
		icon.body,
		icon.contentType,
		config.cacheTtl,
		"miss",
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
			const cacheKey = new Request(`${url.origin}${url.pathname}`, {
				method: "GET",
			});
			const response = await handleIcon(url.pathname, config, ctx, cacheKey);

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
