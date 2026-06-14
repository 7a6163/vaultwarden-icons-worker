import { describe, expect, test } from "vitest";
import { isPublicHostname, parseDomain } from "../src/ssrf";

describe("parseDomain", () => {
  test("extracts a bare domain from the path", () => {
    expect(parseDomain("/github.com")).toEqual({
      host: "github.com",
      origin: "https://github.com",
    });
  });

  test("ignores a trailing /icon.png style suffix", () => {
    expect(parseDomain("/github.com/icon.png")).toEqual({
      host: "github.com",
      origin: "https://github.com",
    });
  });

  test("lowercases the host", () => {
    expect(parseDomain("/GitHub.COM")?.host).toBe("github.com");
  });

  test("preserves an explicit non-standard port in the origin", () => {
    expect(parseDomain("/example.com:8443")).toEqual({
      host: "example.com",
      origin: "https://example.com:8443",
    });
  });

  test("decodes percent-encoded input", () => {
    expect(parseDomain("/example%2Ecom")?.host).toBe("example.com");
  });

  test("returns null for an empty path", () => {
    expect(parseDomain("/")).toBeNull();
    expect(parseDomain("")).toBeNull();
  });

  test("returns null for clearly invalid hosts", () => {
    expect(parseDomain("/ ")).toBeNull();
    expect(parseDomain("/http://x")).toBeNull();
  });
});

describe("isPublicHostname", () => {
  test("accepts normal public domains", () => {
    expect(isPublicHostname("github.com")).toBe(true);
    expect(isPublicHostname("sub.example.co.uk")).toBe(true);
    expect(isPublicHostname("xn--80ak6aa92e.com")).toBe(true); // punycode
  });

  test("rejects IPv4 literals", () => {
    expect(isPublicHostname("127.0.0.1")).toBe(false);
    expect(isPublicHostname("10.0.0.5")).toBe(false);
    expect(isPublicHostname("169.254.169.254")).toBe(false);
    expect(isPublicHostname("8.8.8.8")).toBe(false);
  });

  test("rejects IPv6 literals", () => {
    expect(isPublicHostname("[::1]")).toBe(false);
    expect(isPublicHostname("::1")).toBe(false);
    expect(isPublicHostname("[fe80::1]")).toBe(false);
  });

  test("rejects single-label / internal hostnames", () => {
    expect(isPublicHostname("localhost")).toBe(false);
    expect(isPublicHostname("router")).toBe(false);
  });

  test("rejects reserved TLD suffixes", () => {
    expect(isPublicHostname("printer.local")).toBe(false);
    expect(isPublicHostname("db.internal")).toBe(false);
    expect(isPublicHostname("foo.localhost")).toBe(false);
    expect(isPublicHostname("host.lan")).toBe(false);
  });

  test("rejects operator-supplied blocked suffixes", () => {
    expect(isPublicHostname("secret.corp.example.com", ["corp.example.com"])).toBe(false);
    expect(isPublicHostname("ok.example.com", ["corp.example.com"])).toBe(true);
  });
});
