// ── In-memory cache (Map-based) ────────────────────────────────────────────
// node-cache doesn't run on Workers. This is a drop-in-shaped replacement,
// but with a real caveat: it's a plain module-level Map, so it only survives
// as long as the current isolate does. Cloudflare reuses isolates for a
// while under steady traffic, so this still cuts real work, but don't expect
// Railway-level persistence — a cold isolate starts with an empty cache.
// If you need caching that survives across isolates/deploys, swap this for
// Workers KV (`env.CACHE.get/put`) — that requires threading `env` through,
// which this file intentionally avoids to keep the scraper code unchanged.

interface Entry {
  value: any;
  expiresAt: number;
}

const store = new Map<string, Entry>();

const TTL = {
  mapping: parseInt(process.env.CACHE_TTL_MAPPING || '86400'), // 24h
  episodes: parseInt(process.env.CACHE_TTL_EPISODES || '3600'), // 1h
  stream: parseInt(process.env.CACHE_TTL_STREAM || '300'), // 5min
};

export function cacheGet<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value as T;
}

export function cacheSet(key: string, data: any, type: keyof typeof TTL = 'mapping') {
  store.set(key, { value: data, expiresAt: Date.now() + TTL[type] * 1000 });
}

export function cacheDel(key: string) {
  store.delete(key);
}

export function cacheStats() {
  return { keys: store.size };
}
