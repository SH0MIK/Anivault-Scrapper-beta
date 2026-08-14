import { Hono } from 'hono';
import { cors } from 'hono/cors';
import routes from './routes';
import discordRelay from './discord-relay';

type Bindings = {
  ASSETS: { fetch: typeof fetch };
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors());

// ── Minimal best-effort rate limiting ───────────────────────────────────
// express-rate-limit doesn't run on Workers, and a hand-rolled in-memory
// limiter here would only be as reliable as this isolate's lifetime (same
// caveat as the caches in utils/). The Workers-native replacement is
// Cloudflare's built-in Rate Limiting Rules, configured on the dashboard
// against this Worker's route — no code needed, and it's actually reliable
// across all edge locations. Recommended over anything done in-Worker.
// A basic in-isolate fallback is kept below in case you don't set that up.
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
app.use('/api/*', async (c, next) => {
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000');
  const max = parseInt(process.env.RATE_LIMIT_MAX || '60');
  const ip = c.req.header('cf-connecting-ip') || 'unknown';
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + windowMs });
  } else {
    bucket.count++;
    if (bucket.count > max) {
      return c.json({ error: 'Too many requests, please slow down.' }, 429);
    }
  }
  await next();
});

app.route('/api', routes);
app.route('/discord', discordRelay);

// Static docs/tester page — served via Workers Static Assets.
// Configured in wrangler.toml under [assets], binding = "ASSETS".
app.get('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
