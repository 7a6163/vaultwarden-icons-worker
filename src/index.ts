/**
 * vaultwarden-icons — Cloudflare Worker icon service for Vaultwarden.
 *
 * Vaultwarden is pointed at this Worker via `ICON_SERVICE=https://<host>/{}`.
 * It responds to clients with a redirect to `/<domain>`, and this Worker fetches
 * the favicon server-side and returns the bytes — so the target site only ever
 * sees Cloudflare's IP, never the Vaultwarden server or the end client.
 */

import { FALLBACK_CONTENT_TYPE, FALLBACK_ICON } from "./fallback";
import { getIcon, type IconFetchOptions } from "./favicon";
import { isPublicHostname, parseDomain } from "./ssrf";

export interface Env {
	readonly BLOCKED_SUFFIXES?: string;
	readonly MAX_ICON_BYTES?: string;
	readonly FETCH_TIMEOUT_MS?: string;
	readonly CACHE_TTL_SECONDS?: string;
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
	};
}

function imageResponse(
	body: BodyInit,
	contentType: string,
	maxAge: number,
	status: "hit" | "miss" | "fallback",
): Response {
	return new Response(body, {
		status: 200,
		headers: {
			"content-type": contentType,
			"cache-control": `public, max-age=${maxAge}`,
			"x-content-type-options": "nosniff",
			"access-control-allow-origin": "*",
			"x-icon-result": status,
		},
	});
}

function fallbackResponse(negativeTtl: number): Response {
	return imageResponse(
		FALLBACK_ICON,
		FALLBACK_CONTENT_TYPE,
		negativeTtl,
		"fallback",
	);
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
		return fallbackResponse(config.negativeTtl);
	}

	const icon = await getIcon(domain, config);
	if (!icon) {
		const miss = fallbackResponse(config.negativeTtl);
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

		// Browsers auto-request the Worker's own favicon; answer with the fallback.
		if (url.pathname === "/favicon.ico") {
			return fallbackResponse(config.negativeTtl);
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
			// An icon service must always return an image — never surface a 500.
			return fallbackResponse(config.negativeTtl);
		}
	},
} satisfies ExportedHandler<Env>;
