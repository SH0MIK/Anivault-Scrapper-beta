import http, { HttpConfig, HttpResponse } from './http';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || '';

// Cache CF clearance cookies per domain for 25 minutes.
// NOTE: this Map only lives as long as the current Worker isolate — under
// load Cloudflare may spin up fresh isolates, so the cache hit rate here
// will be lower than it was on a single always-on Railway process. It still
// helps (isolates are commonly reused for a while), just isn't a guarantee.
const cfCache = new Map<string, { cookies: string; userAgent: string; expiresAt: number }>();

async function getCfClearance(baseURL: string): Promise<{ cookies: string; userAgent: string } | null> {
  if (!FLARESOLVERR_URL) return null;

  let domain: string;
  try {
    domain = new URL(baseURL).hostname;
  } catch {
    return null;
  }

  const cached = cfCache.get(domain);
  if (cached && cached.expiresAt > Date.now()) {
    return { cookies: cached.cookies, userAgent: cached.userAgent };
  }

  try {
    const res = await http.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'request.get',
      url: baseURL,
      maxTimeout: 60000,
    }, { timeout: 70000 });

    const solution = res.data?.solution;
    if (!solution) return null;

    const cookies = (solution.cookies as any[]).map((c: any) => `${c.name}=${c.value}`).join('; ');
    const result = { cookies, userAgent: solution.userAgent as string };
    cfCache.set(domain, { ...result, expiresAt: Date.now() + 25 * 60 * 1000 });
    return result;
  } catch (e) {
    console.error('[FlareSolverr] failed:', (e as Error).message);
    return null;
  }
}

// Minimal axios-instance-shaped client: only .get()/.post() with the config
// shape the scrapers actually use (baseURL resolution + default headers +
// optional FlareSolverr cookie injection). Not a general axios replacement.
class Client {
  constructor(
    private baseURL: string,
    private defaultHeaders: Record<string, string>,
    private useFlareSolverr: boolean
  ) {}

  private async resolveHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const headers = { ...this.defaultHeaders, ...(extra || {}) };
    if (this.useFlareSolverr) {
      const cf = await getCfClearance(this.baseURL);
      if (cf) {
        headers['Cookie'] = cf.cookies;
        headers['User-Agent'] = cf.userAgent;
      }
    }
    return headers;
  }

  private resolveUrl(path: string): string {
    return /^https?:\/\//i.test(path) ? path : this.baseURL + path;
  }

  async get<T = any>(path: string, config: HttpConfig = {}): Promise<HttpResponse<T>> {
    const headers = await this.resolveHeaders(config.headers);
    return http.get<T>(this.resolveUrl(path), { ...config, headers, timeout: config.timeout ?? 15000 });
  }

  async post<T = any>(path: string, body?: any, config: HttpConfig = {}): Promise<HttpResponse<T>> {
    const headers = await this.resolveHeaders(config.headers);
    return http.post<T>(this.resolveUrl(path), body, { ...config, headers, timeout: config.timeout ?? 15000 });
  }
}

// `useFlareSolverr` is opt-in (defaults to false). Only pass `true` for a
// site actually behind Cloudflare's bot challenge. Sites that don't
// need it (e.g. AnimeHeaven, Anikoto) should NOT set this — otherwise every request
// pays the cost of a slow/cold FlareSolverr round trip for no reason.
export function makeClient(baseURL: string, referer: string, useFlareSolverr: boolean = false, extra?: Record<string, string>): Client {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': referer,
    'Origin': new URL(referer).origin,
    'X-Requested-With': 'XMLHttpRequest',
    ...extra,
  };
  return new Client(baseURL, headers, useFlareSolverr);
}

export function makeAjaxClient(baseURL: string, referer: string, useFlareSolverr: boolean = false, extra?: Record<string, string>): Client {
  return makeClient(baseURL, referer, useFlareSolverr, {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    ...extra,
  });
}

class AnilistClient {
  async post<T = any>(_path: string, body?: any): Promise<HttpResponse<T>> {
    return http.post<T>('https://graphql.anilist.co', body, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export const anilistClient = new AnilistClient();
