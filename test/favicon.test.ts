import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { getIcon } from "../src/favicon";

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

	test("skips SVG icons and falls through to favicon.ico", async () => {
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/" })
			.reply(200, '<link rel="icon" href="/fav.svg">', {
				headers: { "content-type": "text/html" },
			});
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/fav.svg" })
			.reply(200, "<svg/>", { headers: { "content-type": "image/svg+xml" } });
		fetchMock
			.get("https://example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(200, "ICO", { headers: { "content-type": "image/x-icon" } });

		const icon = await getIcon(DOMAIN, OPTS);
		expect(icon?.contentType).toBe("image/x-icon");
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
});
