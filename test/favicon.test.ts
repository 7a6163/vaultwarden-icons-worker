import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { collectIconLinks, getIcon, readCapped } from "../src/favicon";

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

describe("collectIconLinks", () => {
	test("collects at most MAX_DISCOVERED_LINKS candidates from hostile HTML", async () => {
		const html = '<link rel="icon" href="/i.png">'.repeat(60);
		const links = await collectIconLinks(
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

		const links = await collectIconLinks(new Response(html));
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

	test("degrades to no candidates when the body cannot be read", async () => {
		const response = new Response('<link rel="icon" href="/a.png">');
		await response.text(); // body now disturbed: the rewriter cannot consume it

		expect(await collectIconLinks(response)).toEqual([]);
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
