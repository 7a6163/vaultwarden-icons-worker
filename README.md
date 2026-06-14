# vaultwarden-icons

A small Cloudflare Worker that resolves and serves website favicons for
[Vaultwarden](https://github.com/dani-garcia/vaultwarden), so that **your
Vaultwarden server's IP is never exposed** to the sites your users have saved.

## Why

Vaultwarden's default icon service (`ICON_SERVICE=internal`) downloads each
site's favicon **from your server**. Every saved login leaks your server's
egress IP to that domain. The built-in alternatives (`duckduckgo`, `google`,
`bitwarden`) avoid that, but instead hand the list of domains your users look up
to a third party.

This Worker is a third option: a favicon resolver **you own**, running on
Cloudflare's edge.

```
Client (web vault / extension / mobile)
   │  GET /icons/github.com/icon.png
   ▼
Vaultwarden  ──302/307 redirect──▶  https://vaultwarden-icons.example.com/github.com
   │   (server makes NO outbound request)
   ▼  client follows redirect
Cloudflare Worker  ──fetch──▶  github.com  (HTML <link rel=icon> + /favicon.ico)
   │   returns the image BYTES (reverse proxy, not a second redirect)
   ▼                                  ▲ target site sees only Cloudflare's IP
Client renders icon
```

Because the Worker **fetches and returns the bytes** (rather than redirecting the
client onward to the target), the target site never sees the client's IP either.
All three parties — server, client, target — are shielded.

### What this is and is not

- ✅ Hides the Vaultwarden **server** IP from target sites (server makes no icon request).
- ✅ Hides the **client** IP from target sites (the Worker fetches, not the client).
- ✅ No third-party icon service involved — the Worker does its own discovery.
- ❌ Not an `HTTPS_PROXY`/SOCKS forward proxy. A Cloudflare Worker cannot serve as
  `HTTPS_PROXY` for Vaultwarden's internal fetcher — that requires a real proxy
  (VPS/Tor/WARP). This project uses Vaultwarden's `ICON_SERVICE` redirect model instead.

## How it works

For a request to `/<domain>` the Worker:

1. **Validates the host** (`src/ssrf.ts`) — rejects IP literals, `localhost`,
   single-label and reserved-TLD names (`.local`, `.internal`, …), and any
   operator-configured blocked suffixes. The Worker is public, so it re-validates
   every host independently of Vaultwarden.
2. **Discovers candidates** (`src/favicon.ts`) — fetches the site HTML and uses
   [`HTMLRewriter`](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/)
   to extract `<link rel="icon">` / `apple-touch-icon` hrefs, ordered by declared
   size, then falls back to `/favicon.ico`. Every discovered href is re-validated
   against the SSRF guard before it is fetched.
3. **Validates the response** (`src/sanitize.ts`) — only raster image types are
   served. **SVG is refused** to avoid script injection. A byte cap and per-request
   timeout are enforced.
4. **Caches** at the edge (Cloudflare Cache API) and returns the bytes with
   `Cache-Control`. When no icon can be found (or the host is rejected) it returns
   a cacheable **404** so each client renders its own built-in placeholder, rather
   than serving a foreign or blank image.

## Deploy

```bash
npm install
npx wrangler login

# (optional) bind a custom domain in wrangler.jsonc:
#   "routes": [{ "pattern": "vaultwarden-icons.example.com", "custom_domain": true }]

npm run deploy
```

Then point Vaultwarden at it (environment variables — **no Vaultwarden code
changes**):

```ini
ICON_SERVICE=https://vaultwarden-icons.example.com/{}   # exactly one {} placeholder
ICON_REDIRECT_CODE=307                          # 308 if you want clients to cache the redirect
```

Vaultwarden derives its Content-Security-Policy `img-src` from the icon-service
URL prefix automatically, so the web vault loads icons from the Worker with no
further configuration.

## Configuration

Set in `wrangler.jsonc` under `vars` (all are strings):

| Var | Default | Meaning |
|-----|---------|---------|
| `MAX_ICON_BYTES` | `524288` | Reject favicons larger than this (bytes). |
| `FETCH_TIMEOUT_MS` | `5000` | Per-request outbound timeout (ms). |
| `CACHE_TTL_SECONDS` | `604800` | Edge cache TTL for resolved icons (7 days). |
| `BLOCKED_SUFFIXES` | `""` | Comma-separated hostname suffixes to additionally refuse. |

## Development

```bash
npm run dev        # local Worker at http://localhost:8787  (try /github.com)
npm test           # vitest (unit + integration via @cloudflare/vitest-pool-workers)
npm run typecheck  # tsc --noEmit
npm run lint       # biome lint
```

### Testing notes

- Unit tests (`test/ssrf`, `test/sanitize`, `test/favicon`) cover host validation,
  content-type rules, and the discovery/fetch logic — the favicon tests mock
  outbound HTTP with `fetchMock` from `cloudflare:test`.
- `test/worker.test.ts` covers routing, validation and fallback through `SELF`.
  It intentionally does **not** use `fetchMock`: the undici mock and `SELF`
  deadlock together in the Workers pool, so the outbound path is covered only at
  the unit level.

## Security

- **SSRF**: only public, name-based http(s) hosts are fetched; IP literals and
  internal/reserved names are refused at request entry and again for every
  discovered icon href.
- **SVG**: refused (potential XSS) — the Worker serves raster images only.
- **Abuse**: the endpoint is public (clients reach it via a redirect, so it cannot
  require an auth header). Responses are images only and size-capped. Add a
  Cloudflare WAF rate-limiting rule on the Worker route to bound abuse.

## Roadmap

- SVG sanitization (serve sanitized SVG instead of refusing).
- Optional KV-backed negative cache across colos.
- Optional content-sniffing to reject responses whose bytes don't match an image
  magic number even when the `Content-Type` claims otherwise.

## License

Released under the [MIT License](LICENSE).
