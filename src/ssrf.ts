/**
 * SSRF / abuse guards for the icon proxy.
 *
 * The Worker is publicly reachable, so it must validate every host it is asked
 * to fetch — independently of whatever validation Vaultwarden already did
 * before issuing its redirect. We only ever fetch real, public, name-based
 * hosts over https; IP literals and internal/reserved names are refused.
 */

export interface ParsedDomain {
  /** Lower-cased hostname, e.g. "github.com". */
  readonly host: string;
  /** Origin to fetch, preserving any explicit non-standard port. */
  readonly origin: string;
}

/** Reserved / non-public top-level labels we never resolve. */
const RESERVED_TLDS: ReadonlySet<string> = new Set([
  "local",
  "localhost",
  "internal",
  "lan",
  "home",
  "corp",
  "intranet",
  "test",
  "example",
  "invalid",
]);

/** Loose hostname shape: labels plus an optional :port. Rejects schemes, spaces, slashes. */
const HOST_SHAPE = /^[a-z0-9.-]+(:\d{1,5})?$/i;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Extract the target domain from the request path.
 *
 * Vaultwarden substitutes the bare host into the icon-service template
 * (`https://vaultwarden-icons.example.com/{}`), so the path looks like `/github.com`.
 * Anything that is not a plausible host returns null.
 */
export function parseDomain(pathname: string): ParsedDomain | null {
  const firstSegment = safeDecode(pathname.replace(/^\/+/, "")).split("/")[0] ?? "";
  if (!firstSegment || !HOST_SHAPE.test(firstSegment)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(`https://${firstSegment}`);
  } catch {
    return null;
  }

  if (!url.hostname) {
    return null;
  }

  return { host: url.hostname.toLowerCase(), origin: url.origin };
}

function isIpLiteral(host: string): boolean {
  // Brackets already stripped: any colon means IPv6.
  if (host.includes(":")) {
    return true;
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * True only for hosts we are willing to fetch: multi-label public names that
 * are not IP literals, reserved TLDs, or operator-blocked suffixes.
 */
export function isPublicHostname(host: string, blockedSuffixes: readonly string[] = []): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized || isIpLiteral(normalized)) {
    return false;
  }

  const labels = normalized.split(".");
  if (labels.length < 2 || labels.some((label) => label.length === 0)) {
    return false;
  }

  const tld = labels[labels.length - 1] ?? "";
  if (RESERVED_TLDS.has(tld)) {
    return false;
  }

  for (const suffix of blockedSuffixes) {
    const cleaned = suffix.trim().toLowerCase().replace(/^\.+/, "");
    if (cleaned && (normalized === cleaned || normalized.endsWith(`.${cleaned}`))) {
      return false;
    }
  }

  return true;
}
