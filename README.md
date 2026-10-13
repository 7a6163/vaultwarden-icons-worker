# vaultwarden-icons

[![CI](https://github.com/7a6163/vaultwarden-icons-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/7a6163/vaultwarden-icons-worker/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/7a6163/vaultwarden-icons-worker/branch/main/graph/badge.svg)](https://codecov.io/gh/7a6163/vaultwarden-icons-worker)

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
- ✅ The Worker does its own discovery first. Only when that fails does it ask a
  third-party icon service, **server-side** (the client is never exposed). The
  shipped `wrangler.jsonc` uses DuckDuckGo; set `FALLBACK_ICON_SERVICE` to `""`
  to never contact a third party.
- ❌ Not an `HTTPS_PROXY`/SOCKS forward proxy. A Cloudflare Worker cannot serve as
  `HTTPS_PROXY` for Vaultwarden's internal fetcher — that requires a real proxy
  (VPS/Tor/WARP). This project uses Vaultwarden's `ICON_SERVICE` redirect model instead.

## How it works

For a request to `/<domain>` the Worker:

1. **Validates the host** (`src/ssrf.ts`) — rejects IP literals, `localhost`,
   single-label and reserved-TLD names (`.local`, `.internal`, …), and any
   operator-configured blocked suffixes. The Worker is public, so it re-validates
   every host independently of Vaultwarden.
2. **Discovers candidates** (`src/favicon.ts`) — fetches the site HTML, uses
   [`HTMLRewriter`](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/)
   to extract `<link rel="icon">` / `apple-touch-icon` hrefs, and tries them in
   the order described under [Icon selection](#icon-selection). Every
   discovered href is re-validated against the SSRF guard before it is fetched.
3. **Validates the response** (`src/sanitize.ts`) — raster image types are served
   as-is; a generic `Content-Type` (`application/octet-stream`, `text/plain`, none)
   is accepted only when the leading bytes are a known image format. **SVG is sanitized** with [`svg-hush`](https://crates.io/crates/svg-hush)
   compiled to WASM (`svg-sanitizer/`) — the same allowlist sanitizer Vaultwarden
   uses internally — then served behind a strict `Content-Security-Policy` sandbox.
   A byte cap, a per-request timeout and an overall lookup budget (2× the timeout)
   are enforced.
4. **Caches** at the edge (Cloudflare Cache API) and returns the bytes with
   `Cache-Control`. When no icon can be found (or the host is rejected) it returns
   a cacheable **404** so each client renders its own built-in placeholder, rather
   than serving a foreign or blank image. A miss caused by a timeout, network
   error, 5xx or 429 is cached for only 5 minutes. The `x-icon-result` header
   reports `miss`, `hit`, `fallback` or `none`.

## Icon selection

There is no standard order: HTML lets a page declare several icons and leaves
the choice to the browser. The Worker aims for the sharpest icon, since a small
one looks blurry when scaled up.

1. **Collect `<link>` icons** from the homepage: `rel` of `icon`, `shortcut`,
   `apple-touch-icon`, `apple-touch-icon-precomposed`, `fluid-icon` or
   `mask-icon` (at most 50). Parsing stops at `<body>` once an icon has been
   found. Otherwise it keeps reading up to 1 MiB, because pages that stream
   their metadata (Next.js) put the icon link inside `<body>`.
2. **Rank each link** by how sharp it should render, best first:

   | Rank | Link | Why |
   | --- | --- | --- |
   | 1 | SVG (`type` contains `svg`, `sizes="any"`, or an `.svg` href) | Vector, sharp at any size |
   | 2 | Declared `sizes`, largest first (`"16x16 32x32 256x256"` counts as 256) | Explicit size |
   | 3 | `apple-touch-icon` without `sizes`, treated as 180px | iOS home-screen convention |
   | 4 | `icon` without `sizes` | Unknown, often 16 or 32px |
   | 5 | `mask-icon` | Safari's single-colour pinned-tab glyph |

   Duplicates are dropped and the top 5 are tried in order.
3. **Check the real size.** Each raster's pixel size is read from its header
   (PNG, GIF, ICO, WebP). An icon at least as large as its rank is returned
   immediately. One smaller than claimed (e.g. Instagram's 32×32 file tagged
   `sizes="192x192"`) is set aside while the next candidate is tried. The first
   honest icon then wins unless a set-aside one is larger; if none is honest,
   the largest set-aside icon is returned. SVGs and JPEGs have no size check.
4. **`/favicon.ico`** on the requested host is always tried after the links.
5. **The redirect target's `/favicon.ico`.** When the homepage redirects to
   another host, such as a login or shop page (`tw.battle.net` →
   `tw.shop.battle.net`), that host's `/favicon.ico` is tried as well.
6. **The fallback service**, if `FALLBACK_ICON_SERVICE` is set, is fetched
   server-side only when everything above failed.

Not used: `manifest.json` icons (they would cost another request per lookup)
and per-display-size targeting (the largest available icon is returned).

## Deploy

```bash
npm install
npx wrangler login

# bind a custom domain in wrangler.jsonc (the Cache API is a no-op on
# *.workers.dev, so without one nothing is cached at the edge):
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
| `FALLBACK_ICON_SERVICE` | `duckduckgo` | `""` disables it (also the behaviour when unset). When own discovery fails, fetch from a third party **server-side** (the client is never exposed): `duckduckgo`, `google`, `bitwarden`, or a custom `https://…/{}` URL. |

## Development

```bash
npm run dev        # local Worker at http://localhost:8787  (try /github.com)
npm test           # vitest (unit + integration via @cloudflare/vitest-pool-workers)
npm run test:coverage  # same, with istanbul coverage (CI enforces 100%)
npm run test:mutation  # stryker mutation testing (~4 min)
npm run clean:workerd  # kill workerd processes left behind by test runs
npm run typecheck  # tsc --noEmit
npm run lint       # oxlint     (npm run format = oxfmt)
```

### Testing notes

- Unit tests (`test/ssrf`, `test/sanitize`, `test/favicon`) cover host validation,
  content-type rules, and the discovery/fetch logic — the favicon tests mock
  outbound HTTP with `fetchMock` from `cloudflare:test`.
- `test/worker.test.ts` covers routing, validation and the 404 path through `SELF`.
  It intentionally does **not** use `fetchMock`: the undici mock and `SELF`
  deadlock together in the Workers pool. `test/worker-icon.test.ts` covers the
  end-to-end success path (headers, SVG CSP, edge cache) by invoking the handler
  directly with `createExecutionContext()`, which works with `fetchMock`.
- Coverage is enforced at 100% (statements, branches, functions, lines) by
  `vitest.config.ts`, and the lcov report is uploaded to Codecov from CI.
- `vitest-pool-workers` can leave `workerd` processes running after a test run.
  A mutation run leaves one per mutant (~750), enough to exhaust macOS's process
  limit (`spawn EAGAIN`), so `test:mutation` ends with `npm run clean:workerd`,
  which only kills this checkout's `workerd` and keeps Stryker's exit code.
- Mutation testing (`npm run test:mutation`) currently kills 744/744 mutants.
  It runs the whole suite per mutant via Stryker's command runner, because the
  vitest runner forces a thread pool that `vitest-pool-workers` cannot use; the
  active mutant is handed to workerd by `test/stryker-setup.ts`. It does not gate
  PRs (the sandboxed Workers runtime is occasionally flaky to start); instead
  `.github/workflows/mutation.yml` runs it weekly (Mondays 03:00 UTC, or on
  demand from the Actions tab) and uploads the HTML report as an artifact.

## Security

- **SSRF**: only public, name-based http(s) hosts are fetched; IP literals and
  internal/reserved names (and `BLOCKED_SUFFIXES`) are refused at request entry,
  for every discovered icon href, and for every redirect hop (redirects are
  followed manually, at most 5).
- **Caching**: the edge cache is keyed on the normalized host, so path variants
  (`/GitHub.com`, `/github.com/<junk>`) cannot bypass it.
- **SVG**: sanitized with `svg-hush` (WASM) to strip scripts and external refs,
  then served behind a `default-src 'none'; sandbox` CSP — defense in depth.
- **Abuse**: the endpoint is public (clients reach it via a redirect, so it cannot
  require an auth header). Responses are images only and size-capped. Add a
  Cloudflare WAF rate-limiting rule on the Worker route to bound abuse.

## Roadmap

- Optional KV-backed negative cache across colos.
- Optional content-sniffing to reject responses whose bytes don't match an image
  magic number even when the `Content-Type` claims otherwise.

## License

Released under the [MIT License](LICENSE).
