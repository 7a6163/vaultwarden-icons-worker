import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
	collectIconLinks,
	type FetchTrace,
	getIcon,
	readCapped,
} from "../src/favicon";

const OPTS = { maxBytes: 524_288, timeoutMs: 5_000 };
const DOMAIN = { host: "example.com", origin: "https://example.com" };

const enc = (s: string) => new TextEncoder().encode(s);

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("getIcon", () => {
	test("discovers <link rel=icon> and returns its bytes", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(
				200,
				'<html><head><link rel="icon" href="/fav.png" sizes="32x32"></head></html>',
				{
					headers: { "content-type": "text/html" },
				},
			);
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/fav.png" })
			.reply(200, "PNGDATA", { headers: { "content-type": "image/png" } });

		const icon = await getIcon(DOMAIN, OPTS);
		if (!icon) throw new Error("expected an icon");
		expect(icon.contentType).toBe("image/png");
		expect(new Uint8Array(icon.body)).toEqual(enc("PNGDATA"));
	});

	test("prefers the largest declared icon size", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(
				200,
				'<link rel="icon" href="/small.png" sizes="16x16">' +
					'<link rel="icon" href="/big.png" sizes="180x180">',
				{ headers: { "content-type": "text/html" } },
			);
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/big.png" })
			.reply(200, "BIG", { headers: { "content-type": "image/png" } });

		const icon = await getIcon(DOMAIN, OPTS);
		if (!icon) throw new Error("expected an icon");
		expect(new Uint8Array(icon.body)).toEqual(enc("BIG"));
	});

	test("falls back to /favicon.ico when no link tags exist", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, "<html><head></head></html>", {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(200, "ICO", { headers: { "content-type": "image/x-icon" } });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/x-icon");
	});

	test("sanitizes and serves an SVG icon (strips scripts)", async () => {
		const dirty =
			'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
			'<script>alert(1)</script><rect width="16" height="16" fill="red"/></svg>';
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, '<link rel="icon" href="/fav.svg">', {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/fav.svg" })
			.reply(200, dirty, { headers: { "content-type": "image/svg+xml" } });

		const icon = await getIcon(DOMAIN, OPTS);
		if (!icon) throw new Error("expected an icon");
		expect(icon.contentType).toBe("image/svg+xml");
		const text = new TextDecoder().decode(icon.body);
		expect(text).not.toContain("<script");
	});

	test("never fetches an icon href that resolves to a private host", async () => {
		// Only the HTML and favicon.ico are registered. If the code tried to fetch
		// the internal href, disableNetConnect would throw and fail the test.
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, '<link rel="icon" href="http://10.0.0.5/admin/icon.png">', {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(200, "ICO", { headers: { "content-type": "image/x-icon" } });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/x-icon");
	});

	test("rejects icons larger than the byte cap", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, "<html></html>", {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(200, "X".repeat(50), { headers: { "content-type": "image/png" } });

		const icon = await getIcon(DOMAIN, { maxBytes: 10, timeoutMs: 5_000 });
		expect(icon).toBeNull();
	});

	test("returns null when no candidate yields an image", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, "<html></html>", {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(404, "nope");

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon).toBeNull();
	});

	test("degrades to /favicon.ico when the HTML request errors mid-flight", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.replyWithError(new Error("connection reset"));
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(200, "ICO", { headers: { "content-type": "image/x-icon" } });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/x-icon");
	});

	test("returns null (caller serves fallback) when every upstream request errors", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.replyWithError(new Error("connection reset"));
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.replyWithError(new Error("connection reset"));

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon).toBeNull();
	});

	test("uses the configured fallback service when own discovery fails", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, "<html></html>", {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(404, "no");
		fetchMock
			.get("https://icons.duckduckgo.com")
			.intercept({ path: "/ip3/example.com.ico" })
			.reply(200, "DDG", { headers: { "content-type": "image/x-icon" } });

		const icon = await getIcon(DOMAIN, {
			...OPTS,
			fallbackUrl: "https://icons.duckduckgo.com/ip3/{}.ico",
		});
		expect(icon?.contentType).toBe("image/x-icon");
	});
	test("ignores a non-HTML homepage and falls back to /favicon.ico", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, '{"not":"html"}', {
				headers: { "content-type": "application/json" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(200, "ICO", { headers: { "content-type": "image/x-icon" } });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/x-icon");
	});

	test("refuses a candidate served with a non-image content type", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, '<link rel="icon" href="/fav.png">', {
				headers: { "content-type": "text/html" },
			});
		// An HTML error page returned with a 200 must never be served as an icon.
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/fav.png" })
			.reply(200, "<html>404</html>", {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(404, "no");

		expect(await getIcon(DOMAIN, OPTS)).toBeNull();
	});

	test("drops an SVG that fails sanitization instead of serving it", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, '<link rel="icon" href="/fav.svg">', {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/fav.svg" })
			.reply(200, "<<< not xml at all", {
				headers: { "content-type": "image/svg+xml" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(404, "no");

		expect(await getIcon(DOMAIN, OPTS)).toBeNull();
	});

	test("rejects an empty response body", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, "<html></html>", {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(200, "", { headers: { "content-type": "image/png" } });

		expect(await getIcon(DOMAIN, OPTS)).toBeNull();
	});

	test("still reaches /favicon.ico after the maximum declared candidates", async () => {
		const links = Array.from(
			{ length: 5 },
			(_, i) =>
				`<link rel="icon" href="/i${i}.png" sizes="${90 - i}x${90 - i}">`,
		).join("");
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, links, { headers: { "content-type": "text/html" } });
		for (let i = 0; i < 5; i += 1) {
			fetchMock
				.get("https://example.com")
				.intercept({ path: `/i${i}.png` })
				.reply(404, "no");
		}
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(200, "ICO", { headers: { "content-type": "image/x-icon" } });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/x-icon");
	});

	test("does not call the fallback service when discovery succeeds", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, "<html></html>", {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(200, "ICO", { headers: { "content-type": "image/x-icon" } });

		// No interceptor for the fallback host: reaching it would throw on
		// disableNetConnect, and assertNoPendingInterceptors keeps us honest.
		const icon = await getIcon(DOMAIN, {
			...OPTS,
			fallbackUrl: "https://icons.duckduckgo.com/ip3/{}.ico",
		});
		expect(new Uint8Array(icon?.body ?? new ArrayBuffer(0))).toEqual(
			enc("ICO"),
		);
	});
	test("skips link tags that cannot yield a fetchable icon", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(
				200,
				[
					'<link href="/no-rel.png">', // no rel at all
					'<link rel="stylesheet" href="/style.css">', // not an icon rel
					'<link rel="icon">', // no href
					'<link rel="icon" href="data:image/png;base64,AAAA">', // non-http scheme
					'<link rel="icon" href="http://[">', // unparseable href
				].join(""),
				{ headers: { "content-type": "text/html" } },
			);
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(200, "ICO", { headers: { "content-type": "image/x-icon" } });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/x-icon");
	});

	test("treats a non-numeric sizes attribute as size 0", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(
				200,
				'<link rel="icon" href="/any.svg" sizes="any">' +
					'<link rel="apple-touch-icon" href="/180.png" sizes="180x180">',
				{ headers: { "content-type": "text/html" } },
			);
		// The sized icon sorts first; sizes="any" ranks last, not highest.
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/180.png" })
			.reply(200, "BIG", { headers: { "content-type": "image/png" } });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(new Uint8Array(icon?.body ?? new ArrayBuffer(0))).toEqual(
			enc("BIG"),
		);
	});

	test("fetches a duplicated href only once", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(
				200,
				'<link rel="icon" href="/fav.png"><link rel="shortcut" href="/fav.png">',
				{ headers: { "content-type": "text/html" } },
			);
		// Registered once: a second request for it would fail on the exhausted
		// interceptor, and assertNoPendingInterceptors catches a missed one.
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/fav.png" })
			.reply(404, "no");
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(200, "ICO", { headers: { "content-type": "image/x-icon" } });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/x-icon");
	});

	test("handles a homepage response with no content-type header", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, '<link rel="icon" href="/fav.png">');
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(200, "ICO", { headers: { "content-type": "image/x-icon" } });

		// Without a declared HTML type the body is not parsed for <link> tags.
		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/x-icon");
	});

	test("refuses an icon response with no content-type header", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, "<html></html>", {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(200, "BYTES");

		expect(await getIcon(DOMAIN, OPTS)).toBeNull();
	});

	test("refuses a bodyless success response", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, "<html></html>", {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(204, "", { headers: { "content-type": "image/png" } });

		expect(await getIcon(DOMAIN, OPTS)).toBeNull();
	});

	test("rejects on a declared content-length over the cap without reading", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, "<html></html>", {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(200, "AB", {
				headers: { "content-type": "image/png", "content-length": "999999" },
			});

		expect(
			await getIcon(DOMAIN, { maxBytes: 10, timeoutMs: 5_000 }),
		).toBeNull();
	});

	test("returns null when the fallback service also fails", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, "<html></html>", {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(404, "no");
		fetchMock
			.get("https://icons.duckduckgo.com")
			.intercept({ path: "/ip3/example.com.ico" })
			.reply(404, "no");

		const icon = await getIcon(DOMAIN, {
			...OPTS,
			fallbackUrl: "https://icons.duckduckgo.com/ip3/{}.ico",
		});
		expect(icon).toBeNull();
	});
});

/** Mock the homepage with the given HTML. */
function mockHome(html: string, origin = "https://example.com"): void {
	fetchMock
		.get(origin)
		.intercept({ path: "/" })
		.reply(200, html, { headers: { "content-type": "text/html" } });
}

function mockPath(
	path: string,
	status: number,
	body = "",
	headers: Record<string, string> = {},
	origin = "https://example.com",
): void {
	fetchMock.get(origin).intercept({ path }).reply(status, body, { headers });
}

describe("candidate ranking", () => {
	test("ranks by the largest of several declared sizes", async () => {
		mockHome(
			'<link rel="icon" href="/mid.png" sizes="64x64">' +
				'<link rel="icon" href="/multi.ico" sizes="16x16 32x32 256x256">',
		);
		mockPath("/multi.ico", 200, "ICO", { "content-type": "image/x-icon" });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/x-icon");
	});

	test("reads sizes case-insensitively and uses the longer edge", async () => {
		mockHome(
			'<link rel="icon" href="/a.png" sizes="32x32">' +
				'<link rel="icon" href="/b.png" sizes="16X48">',
		);
		mockPath("/b.png", 200, "B", { "content-type": "image/png" });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(new Uint8Array(icon?.body ?? new ArrayBuffer(0))).toEqual(enc("B"));
	});

	test("tries a mask-icon only after unsized icons", async () => {
		mockHome(
			'<link rel="mask-icon" href="/mask.svg">' +
				'<link rel="icon" href="/plain.png">',
		);
		mockPath("/plain.png", 200, "PNG", { "content-type": "image/png" });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/png");
	});

	test("still reaches /favicon.ico when more links are declared than tried", async () => {
		mockHome(
			Array.from(
				{ length: 7 },
				(_, i) =>
					`<link rel="icon" href="/i${i}.png" sizes="${90 - i}x${90 - i}">`,
			).join(""),
		);
		for (let i = 0; i < 5; i += 1) {
			mockPath(`/i${i}.png`, 404);
		}
		mockPath("/favicon.ico", 200, "ICO", { "content-type": "image/x-icon" });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/x-icon");
	});
});

describe("href resolution", () => {
	test("resolves relative hrefs against the final URL after a redirect", async () => {
		mockPath("/", 301, "", { location: "https://www.example.com/en/" });
		fetchMock
			.get("https://www.example.com")
			.intercept({ path: "/en/" })
			.reply(200, '<link rel="icon" href="img/fav.png">', {
				headers: { "content-type": "text/html" },
			});
		mockPath(
			"/en/img/fav.png",
			200,
			"PNG",
			{ "content-type": "image/png" },
			"https://www.example.com",
		);

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/png");
	});

	test("honours the first <base href>", async () => {
		mockHome(
			'<base target="_top"><base href="/assets/"><base href="/ignored/">' +
				'<link rel="icon" href="fav.png">',
		);
		mockPath("/assets/fav.png", 200, "PNG", { "content-type": "image/png" });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/png");
	});

	test("ignores an unparseable <base href>", async () => {
		mockHome('<base href="http://["><link rel="icon" href="fav.png">');
		mockPath("/fav.png", 200, "PNG", { "content-type": "image/png" });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/png");
	});
});

describe("content sniffing", () => {
	test("serves a generic-typed favicon whose bytes are a known image", async () => {
		mockHome("<html></html>");
		mockPath("/favicon.ico", 200, "\u0000\u0000\u0001\u0000ICO", {
			"content-type": "application/octet-stream",
		});

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/x-icon");
	});

	test("refuses a generic-typed response whose bytes are not an image", async () => {
		mockHome("<html></html>");
		mockPath("/favicon.ico", 200, "<html>not found</html>", {
			"content-type": "text/plain",
		});

		expect(await getIcon(DOMAIN, OPTS)).toBeNull();
	});
});

describe("icon source", () => {
	test("reports an icon found on the site itself", async () => {
		mockHome("<html></html>");
		mockPath("/favicon.ico", 200, "ICO", { "content-type": "image/x-icon" });

		expect((await getIcon(DOMAIN, OPTS))?.source).toBe("site");
	});

	test("reports an icon served by the fallback service", async () => {
		mockHome("<html></html>");
		mockPath("/favicon.ico", 404);
		fetchMock
			.get("https://icons.duckduckgo.com")
			.intercept({ path: "/ip3/example.com.ico" })
			.reply(200, "ICO", { headers: { "content-type": "image/x-icon" } });

		const icon = await getIcon(DOMAIN, {
			...OPTS,
			fallbackUrl: "https://icons.duckduckgo.com/ip3/{}.ico",
		});
		expect(icon?.source).toBe("fallback");
	});
});

describe("transient failures", () => {
	test("are not flagged when the site cleanly has no icon", async () => {
		mockHome("<html></html>");
		mockPath("/favicon.ico", 404);

		const trace: FetchTrace = { transient: false };
		expect(await getIcon(DOMAIN, OPTS, trace)).toBeNull();
		expect(trace.transient).toBe(false);
	});

	test("are flagged on a 5xx", async () => {
		mockHome("<html></html>");
		mockPath("/favicon.ico", 503);

		const trace: FetchTrace = { transient: false };
		expect(await getIcon(DOMAIN, OPTS, trace)).toBeNull();
		expect(trace.transient).toBe(true);
	});

	test("are flagged on a 500 exactly", async () => {
		mockHome("<html></html>");
		mockPath("/favicon.ico", 500);

		const trace: FetchTrace = { transient: false };
		await getIcon(DOMAIN, OPTS, trace);
		expect(trace.transient).toBe(true);
	});

	test("are flagged on a 429", async () => {
		mockHome("<html></html>");
		mockPath("/favicon.ico", 429);

		const trace: FetchTrace = { transient: false };
		await getIcon(DOMAIN, OPTS, trace);
		expect(trace.transient).toBe(true);
	});

	test("are flagged when a request fails outright", async () => {
		// No interceptors: with net connect disabled, every fetch throws.
		const trace: FetchTrace = { transient: false };
		expect(await getIcon(DOMAIN, OPTS, trace)).toBeNull();
		expect(trace.transient).toBe(true);
	});

	test("are not flagged by a 4xx other than 429", async () => {
		mockHome("<html></html>");
		mockPath("/favicon.ico", 499);

		const trace: FetchTrace = { transient: false };
		await getIcon(DOMAIN, OPTS, trace);
		expect(trace.transient).toBe(false);
	});
});

describe("lookup deadline", () => {
	test("stops the whole lookup once the total time budget is spent", async () => {
		// Each request fits the 100ms per-request timeout, but together they
		// exceed the 200ms budget, so the last candidate is never reached.
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(
				200,
				'<link rel="icon" href="/a.png"><link rel="icon" href="/b.png">',
				{
					headers: { "content-type": "text/html" },
				},
			)
			.delay(80);
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/a.png" })
			.reply(404, "no")
			.delay(80);
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/b.png" })
			.reply(200, "PNG", { headers: { "content-type": "image/png" } })
			.delay(80);

		const icon = await getIcon(DOMAIN, { maxBytes: 1_000, timeoutMs: 100 });
		expect(icon).toBeNull();
	});
});

describe("redirects", () => {
	test("follows a redirect to a public host", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, "<html></html>", {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(301, "", {
				headers: { location: "https://cdn.example.org/f.ico" },
			});
		fetchMock
			.get("https://cdn.example.org")
			.intercept({ path: "/f.ico" })
			.reply(200, "ICO", { headers: { "content-type": "image/x-icon" } });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/x-icon");
	});

	test("refuses a redirect to an internal host", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(302, "", { headers: { location: "http://10.0.0.5/" } });
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(302, "", { headers: { location: "http://printer.local/f.ico" } });

		expect(await getIcon(DOMAIN, OPTS)).toBeNull();
	});

	test("refuses a redirect to an operator-blocked suffix", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, "<html></html>", {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(302, "", {
				headers: { location: "https://intranet.corp.example.org/f.ico" },
			});

		expect(
			await getIcon(DOMAIN, { ...OPTS, blockedSuffixes: ["corp.example.org"] }),
		).toBeNull();
	});

	test("gives up after too many redirect hops", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, "<html></html>", {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(302, "", { headers: { location: "/loop" } });
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/loop" })
			.reply(302, "", { headers: { location: "/loop" } })
			.times(5);

		expect(await getIcon(DOMAIN, OPTS)).toBeNull();
	});

	test("treats a redirect without a Location as a failed response", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, "<html></html>", {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(302, "");

		expect(await getIcon(DOMAIN, OPTS)).toBeNull();
	});
});

describe("blocked suffixes", () => {
	test("skips discovered links on an operator-blocked suffix", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(
				200,
				'<link rel="icon" href="https://intranet.corp.example.org/logo.png">',
				{ headers: { "content-type": "text/html" } },
			);
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(200, "ICO", { headers: { "content-type": "image/x-icon" } });

		const icon = await getIcon(DOMAIN, {
			...OPTS,
			blockedSuffixes: ["corp.example.org"],
		});
		expect(icon?.contentType).toBe("image/x-icon");
	});
});

describe("collectIconLinks", () => {
	test("collects at most MAX_DISCOVERED_LINKS candidates from hostile HTML", async () => {
		const html = '<link rel="icon" href="/i.png">'.repeat(60);
		const { links } = await collectIconLinks(
			new Response(html, { headers: { "content-type": "text/html" } }),
		);
		expect(links).toHaveLength(50);
	});

	test("accepts every icon rel and nothing else", async () => {
		const html = [
			'<link rel="icon" href="/a">',
			'<link rel="shortcut" href="/b">',
			'<link rel="apple-touch-icon" href="/c">',
			'<link rel="apple-touch-icon-precomposed" href="/d">',
			'<link rel="mask-icon" href="/e">',
			'<link rel="fluid-icon" href="/f">',
			'<link rel="SHORTCUT ICON" href="/g">', // case- and multi-token-insensitive
			'<link rel="stylesheet" href="/no1">',
			'<link rel="preload" href="/no2">',
			'<link rel="manifest" href="/no3">',
			'<link rel="" href="/no4">',
		].join("");

		const { links } = await collectIconLinks(new Response(html));
		expect(links.map((link) => link.href)).toEqual([
			"/a",
			"/b",
			"/c",
			"/d",
			"/e",
			"/f",
			"/g",
		]);
	});

	test("stops reading at <body> instead of consuming the whole page", async () => {
		// The stream never closes: reading to the end would hang the test.
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(
					enc('<html><head><link rel="icon" href="/a.png"></head><body>'),
				);
				controller.enqueue(enc("<p>more</p>"));
			},
		});
		const { links } = await collectIconLinks(new Response(stream));
		expect(links.map((link) => link.href)).toEqual(["/a.png"]);
	});

	test("stops reading after the HTML byte cap", async () => {
		// An endless page with no <body> tag: only the byte cap ends the read.
		const chunk = enc(`<!-- ${"x".repeat(65_536)} -->`);
		let pulls = 0;
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(enc('<link rel="icon" href="/a.png">'));
			},
			pull(controller) {
				pulls += 1;
				controller.enqueue(chunk);
			},
		});
		const { links } = await collectIconLinks(new Response(stream));
		expect(links.map((link) => link.href)).toEqual(["/a.png"]);
		expect(pulls).toBeLessThan(40);
	});

	test("returns no candidates for a bodyless response", async () => {
		expect(await collectIconLinks(new Response(null))).toEqual({
			base: null,
			links: [],
		});
	});

	test("degrades to no candidates when the body cannot be read", async () => {
		const response = new Response('<link rel="icon" href="/a.png">');
		await response.text(); // body now disturbed: the rewriter cannot consume it

		expect(await collectIconLinks(response)).toEqual({ base: null, links: [] });
	});
});

describe("outbound request headers", () => {
	test("sends a browser user-agent and matching accept headers", async () => {
		// Sites commonly refuse a blank or non-browser UA, so the interceptors
		// only match when the real headers are sent — a miss fails the fetch.
		fetchMock
			.get("https://example.com")
			.intercept({
				path: "/",
				headers: { "user-agent": /^Mozilla\/5\.0 /, accept: /^text\/html,/ },
			})
			.reply(200, '<link rel="icon" href="/fav.png">', {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({
				path: "/fav.png",
				headers: { "user-agent": /^Mozilla\/5\.0 /, accept: /^image\// },
			})
			.reply(200, "PNGDATA", { headers: { "content-type": "image/png" } });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(new Uint8Array(icon?.body ?? new ArrayBuffer(0))).toEqual(
			enc("PNGDATA"),
		);
	});
});

describe("readCapped", () => {
	test("concatenates a multi-chunk body", async () => {
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(enc("AB"));
				controller.enqueue(enc("CD"));
				controller.close();
			},
		});
		const body = await readCapped(new Response(stream), 10);
		expect(new Uint8Array(body ?? new ArrayBuffer(0))).toEqual(enc("ABCD"));
	});

	test("returns null when the body errors mid-stream", async () => {
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(enc("AB"));
				controller.error(new Error("connection reset"));
			},
		});
		expect(await readCapped(new Response(stream), 10)).toBeNull();
	});

	test("returns null for a response with no body", async () => {
		expect(
			await readCapped(new Response(null, { status: 204 }), 10),
		).toBeNull();
	});
});
