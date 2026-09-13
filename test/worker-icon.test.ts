import {
	createExecutionContext,
	fetchMock,
	waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import worker from "../src/index";

// Invoking the handler directly (rather than through SELF) is what lets these
// tests use fetchMock: the undici mock and SELF deadlock in the workers pool.

const ENV = {};

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
	vi.restoreAllMocks();
});

/** Each test uses its own domain so the shared edge cache cannot leak between them. */
async function get(host: string, init?: RequestInit): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`https://proxy.example/${host}`, init),
		ENV,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return res;
}

function mockSite(host: string, html: string): void {
	fetchMock
		.get(`https://${host}`)
		.intercept({ path: "/" })
		.reply(200, html, { headers: { "content-type": "text/html" } });
}

describe("worker icon responses", () => {
	test("serves a resolved raster icon with caching headers", async () => {
		mockSite("raster.example.com", '<link rel="icon" href="/fav.png">');
		fetchMock
			.get("https://raster.example.com")
			.intercept({ path: "/fav.png" })
			.reply(200, "PNGDATA", { headers: { "content-type": "image/png" } });

		const res = await get("raster.example.com");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("x-icon-result")).toBe("miss");
		expect(res.headers.get("cache-control")).toBe("public, max-age=604800");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(await res.text()).toBe("PNGDATA");
	});

	test("sandboxes a sanitized SVG icon with a strict CSP", async () => {
		mockSite("svg.example.com", '<link rel="icon" href="/fav.svg">');
		fetchMock
			.get("https://svg.example.com")
			.intercept({ path: "/fav.svg" })
			.reply(200, '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', {
				headers: { "content-type": "image/svg+xml" },
			});

		const res = await get("svg.example.com");
		expect(res.headers.get("content-type")).toBe("image/svg+xml");
		expect(res.headers.get("content-security-policy")).toContain(
			"default-src 'none'",
		);
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
	});

	test("serves the second request from the edge cache", async () => {
		mockSite("cached.example.com", '<link rel="icon" href="/fav.png">');
		fetchMock
			.get("https://cached.example.com")
			.intercept({ path: "/fav.png" })
			.reply(200, "PNGDATA", { headers: { "content-type": "image/png" } });

		expect((await get("cached.example.com")).status).toBe(200);

		// No interceptors remain: a second upstream fetch would fail the test.
		const res = await get("cached.example.com");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("PNGDATA");
	});

	test("caches the 404 when no icon can be resolved", async () => {
		mockSite("noicon.example.com", "<html></html>");
		fetchMock
			.get("https://noicon.example.com")
			.intercept({ path: "/favicon.ico" })
			.reply(404, "no");

		const res = await get("noicon.example.com");
		expect(res.status).toBe(404);
		expect(res.headers.get("x-icon-result")).toBe("none");
		expect(res.headers.get("cache-control")).toBe("public, max-age=86400");

		const cached = await get("noicon.example.com");
		expect(cached.status).toBe(404);
	});

	test("answers HEAD for a resolvable icon with headers but no body", async () => {
		mockSite("head.example.com", '<link rel="icon" href="/fav.png">');
		fetchMock
			.get("https://head.example.com")
			.intercept({ path: "/fav.png" })
			.reply(200, "PNGDATA", { headers: { "content-type": "image/png" } });

		const res = await get("head.example.com", { method: "HEAD" });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(await res.text()).toBe("");
	});

	test("degrades to a 404 instead of a 500 when the cache lookup throws", async () => {
		vi.spyOn(caches.default, "match").mockRejectedValue(new Error("boom"));

		const res = await get("broken.example.com");
		expect(res.status).toBe(404);
		expect(res.headers.get("x-icon-result")).toBe("none");
	});
});
