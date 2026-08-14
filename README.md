# AniVault Scraper API — Cloudflare Workers port

Ported from the original Express/Railway app to run on Cloudflare Workers
(Hono + native `fetch`). Type-checks clean and bundles successfully with
`wrangler deploy --dry-run` (~1MB / 238KB gzipped).

## Deploy via GitHub + Cloudflare Workers Builds (no CLI needed)

1. Push this folder as a new GitHub repo.
2. In the Cloudflare dashboard: **Workers & Pages → Create → Import a
   repository**, pick this repo. Cloudflare will detect `wrangler.toml` and
   handle `npm install` + build/deploy automatically on every push.
3. Set environment variables/secrets under **Settings → Variables** on the
   deployed Worker (see list below). Don't put secrets in `wrangler.toml`.
4. Every future `git push` auto-deploys.

## Environment variables to set in the dashboard

| Name | Used by | Notes |
|---|---|---|
| `BOT_SECRET` | discord-relay | Secret — must match your PHP config + Vercel bot |
| `VERCEL_BOT_URL` | discord-relay `/relay` | e.g. `https://anivault-bot.vercel.app` |
| `DISCORD_APP_ID` | discord-relay | Discord application ID |
| `SITE_URL` | discord-relay | Defaults to `https://www.anivault.co` |
| `FLARESOLVERR_URL` | fetch.ts, discord-relay | Only needed if you still run FlareSolverr somewhere reachable from the public internet — Workers can't run it itself |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | index.ts fallback limiter | Optional, see caveat below |
| `CACHE_TTL_MAPPING` / `CACHE_TTL_EPISODES` / `CACHE_TTL_STREAM` | cache.ts | Optional, seconds |

## Sources

Only **AnimeHeaven** and **Anikoto** are wired in. Senshi and Miruro were
dropped (both had stopped working) along with everything only they needed:
`scrapers/senshi.ts`, `scrapers/miruro.ts`, and `resolvers/megacloud.ts`
(Senshi's separate embed resolver — not to be confused with the
self-contained megacloud decryption logic inside `anikoto.ts`, which stays).
`crypto-js` was removed from dependencies since it was only used by that
deleted resolver.

## What changed from the Express version

- **Removed entirely:** `image-migrator.ts` (used `basic-ftp`/raw TCP sockets
  and `archiver` — neither can run on Workers, no workaround exists).
- **Removed:** the two `/api/debug/miruro*` routes (marked "remove before
  production" in the original) and `process.uptime()` from `/health` (no
  persistent process on Workers).
- **Dropped as dead code:** `anidao.ts`, `animepahe.ts`, `aniwaves.ts`,
  `reanime.ts` — none of these were actually imported by `routes.ts`.
- **Express → Hono**, `axios` → native `fetch` via a small compatibility
  shim (`src/utils/http.ts`) so the scraper files barely changed.
- **`node-cache` → in-memory `Map`** (`src/utils/cache.ts`). Caveat: this
  only survives as long as the current Worker isolate does — Cloudflare
  reuses isolates for a while under steady traffic, but a cold isolate
  starts with an empty cache. For persistence across isolates/deploys,
  swap to Workers KV.
- **`express-rate-limit` → best-effort in-memory limiter**, same isolate
  caveat as above. The reliable replacement is Cloudflare's native
  **Rate Limiting Rules**, configured in the dashboard against this
  Worker's route — no code needed, and it actually works across the whole
  edge, not just one isolate. Recommended over the in-code fallback.
- **`node:zlib`, `node:buffer`** (used by `miruro.ts`/`anikoto.ts`) work
  natively under the `nodejs_compat` flag with the compatibility date set
  in `wrangler.toml` — no changes needed beyond the `node:` import prefix.
- **`express.static`** → Workers Static Assets (`[assets]` binding in
  `wrangler.toml`, serves `public/index.html`).

## Known unresolved gap

`discord-relay.ts`'s original InfinityFree call used
`new https.Agent({ rejectUnauthorized: false })` to skip TLS certificate
verification. Workers' `fetch` has **no way to disable TLS verification** —
this isn't a missing polyfill, it's not exposed at all. If InfinityFree's
cert is genuinely invalid, this specific call will fail on Workers with no
in-Worker fix; it'd need a valid cert at the source, or that one call
proxied through something that isn't Workers.

## Local dev

```
npm install
npx wrangler dev
```
