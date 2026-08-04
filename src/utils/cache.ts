import NodeCache from 'node-cache';

const cache = new NodeCache({ useClones: false });

const TTL = {
  mapping: parseInt(process.env.CACHE_TTL_MAPPING || '86400'),   // 24h
  episodes: parseInt(process.env.CACHE_TTL_EPISODES || '3600'),  // 1h
  stream: parseInt(process.env.CACHE_TTL_STREAM || '300'),       // 5min
};

export function cacheGet<T>(key: string): T | null {
  return cache.get<T>(key) ?? null;
}

export function cacheSet(key: string, data: any, type: keyof typeof TTL = 'mapping') {
  cache.set(key, data, TTL[type]);
}

export function cacheDel(key: string) {
  cache.del(key);
}

export function cacheStats() {
  return cache.getStats();
}
