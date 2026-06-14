import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

// NOTE: These integration tests deliberately avoid `fetchMock`. The undici
// mock and `SELF` deadlock together in vitest-pool-workers, so the outbound
// favicon-fetch path is covered by the unit tests in favicon.test.ts instead.
// Here we only exercise routing, validation and the 404 path — requests that make
// no outbound request (and therefore need no network mocking).

describe("worker fetch handler", () => {
	test("health check responds on /", async () => {
		const res = await SELF.fetch("https://proxy.example/");
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("ok");
	});

	test("returns 404 for an internal host", async () => {
		const res = await SELF.fetch("https://proxy.example/10.0.0.5");
		expect(res.status).toBe(404);
		expect(res.headers.get("x-icon-result")).toBe("none");
		expect(res.headers.get("cache-control")).toContain("max-age=");
	});

	test("returns 404 for a garbage path without crashing", async () => {
		const res = await SELF.fetch("https://proxy.example/not%20a%20host");
		expect(res.status).toBe(404);
		expect(res.headers.get("x-icon-result")).toBe("none");
	});

	test("answers the worker's own /favicon.ico with a 404", async () => {
		const res = await SELF.fetch("https://proxy.example/favicon.ico");
		expect(res.status).toBe(404);
		expect(res.headers.get("x-icon-result")).toBe("none");
	});

	test("rejects non-GET/HEAD methods", async () => {
		const res = await SELF.fetch("https://proxy.example/example.com", {
			method: "POST",
		});
		expect(res.status).toBe(405);
		expect(res.headers.get("allow")).toContain("GET");
	});
});
