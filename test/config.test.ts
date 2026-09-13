import { describe, expect, test } from "vitest";
import { resolveConfig, resolveFallbackUrl } from "../src/index";

describe("resolveFallbackUrl", () => {
	test("expands the named presets", () => {
		expect(resolveFallbackUrl("duckduckgo")).toBe(
			"https://icons.duckduckgo.com/ip3/{}.ico",
		);
		expect(resolveFallbackUrl(" Google ")).toContain("google.com/s2/favicons");
		expect(resolveFallbackUrl("bitwarden")).toContain("icons.bitwarden.net");
	});

	test("accepts a custom https template with a placeholder", () => {
		expect(resolveFallbackUrl("https://icons.example.com/{}.png")).toBe(
			"https://icons.example.com/{}.png",
		);
	});

	test("is disabled when unset or empty", () => {
		expect(resolveFallbackUrl(undefined)).toBeNull();
		expect(resolveFallbackUrl("   ")).toBeNull();
	});

	test("refuses plaintext http and templates without a placeholder", () => {
		expect(resolveFallbackUrl("http://icons.example.com/{}.png")).toBeNull();
		expect(
			resolveFallbackUrl("https://icons.example.com/fixed.png"),
		).toBeNull();
		expect(resolveFallbackUrl("not a url")).toBeNull();
	});
});

describe("resolveConfig", () => {
	test("applies defaults for missing vars", () => {
		const config = resolveConfig({});
		expect(config.maxBytes).toBe(524_288);
		expect(config.timeoutMs).toBe(5_000);
		expect(config.cacheTtl).toBe(604_800);
		expect(config.fallbackUrl).toBeNull();
		expect(config.blockedSuffixes).toEqual([]);
	});

	test("falls back to defaults on non-positive or junk values", () => {
		const config = resolveConfig({
			MAX_ICON_BYTES: "0",
			FETCH_TIMEOUT_MS: "-1",
			CACHE_TTL_SECONDS: "abc",
		});
		expect(config.maxBytes).toBe(524_288);
		expect(config.timeoutMs).toBe(5_000);
		expect(config.cacheTtl).toBe(604_800);
	});

	test("clamps the negative TTL to one day, or to a shorter cache TTL", () => {
		expect(resolveConfig({}).negativeTtl).toBe(86_400);
		expect(resolveConfig({ CACHE_TTL_SECONDS: "60" }).negativeTtl).toBe(60);
	});

	test("splits and trims blocked suffixes, dropping empties", () => {
		expect(
			resolveConfig({ BLOCKED_SUFFIXES: " corp.example.com , ,internal.test " })
				.blockedSuffixes,
		).toEqual(["corp.example.com", "internal.test"]);
	});
});
