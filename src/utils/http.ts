// ── Fetch-based axios-compatible shim ─────────────────────────────────────
// Workers can't run axios's Node adapter, but almost every call site in this
// project only uses the small subset of axios's API replicated here:
// get/post/patch with {params, headers, timeout, responseType,
// transformResponse, validateStatus}, returning {data, status, headers}, and
// throwing an axios-shaped error (err.isAxiosError / err.response.status) on
// a non-2xx status. This lets scraper files keep `axios.get(url, config)`
// call sites almost verbatim.

export interface HttpResponse<T = any> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  // axios/Node expose the post-redirect URL here; some scrapers read it to
  // detect that a request was redirected. `fetch` follows redirects by
  // default, so `response.url` is the equivalent.
  request: { res: { responseUrl: string } };
}

export interface HttpConfig {
  headers?: Record<string, string>;
  params?: Record<string, any>;
  timeout?: number;
  responseType?: 'json' | 'text' | 'arraybuffer' | 'stream';
  transformResponse?: (data: any) => any;
  validateStatus?: (status: number) => boolean;
}

function buildUrl(url: string, params?: Record<string, any>): string {
  if (!params) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function request<T = any>(
  method: string,
  url: string,
  config: HttpConfig = {},
  body?: any
): Promise<HttpResponse<T>> {
  const fullUrl = buildUrl(url, config.params);
  const controller = new AbortController();
  const timeoutId = config.timeout ? setTimeout(() => controller.abort(), config.timeout) : null;

  const headers: Record<string, string> = { ...(config.headers || {}) };
  let fetchBody: BodyInit | undefined;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) {
      fetchBody = body as any;
    } else {
      fetchBody = JSON.stringify(body);
      if (!('Content-Type' in headers) && !('content-type' in headers)) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  let response: Response;
  try {
    response = await fetch(fullUrl, { method, headers, body: fetchBody, signal: controller.signal });
  } catch (err: any) {
    const e: any = new Error(err?.message || 'Network error');
    e.isAxiosError = true;
    e.config = { url: fullUrl };
    throw e;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  const status = response.status;
  const respHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    respHeaders[k] = v;
  });

  let data: any;
  if (config.responseType === 'arraybuffer') {
    data = await response.arrayBuffer();
  } else if (config.responseType === 'stream') {
    data = response.body;
  } else if (config.transformResponse) {
    const text = await response.text();
    data = config.transformResponse(text);
  } else if (config.responseType === 'text') {
    data = await response.text();
  } else {
    const text = await response.text();
    const ct = respHeaders['content-type'] || '';
    if (ct.includes('json')) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    } else {
      data = text;
    }
  }

  const result: HttpResponse<T> = {
    data,
    status,
    statusText: response.statusText,
    headers: respHeaders,
    request: { res: { responseUrl: response.url } },
  };

  const validate = config.validateStatus ?? ((s: number) => s >= 200 && s < 300);
  if (!validate(status)) {
    const err: any = new Error(`Request failed with status code ${status}`);
    err.isAxiosError = true;
    err.response = result;
    err.config = { url: fullUrl };
    throw err;
  }

  return result;
}

const http = {
  get: <T = any>(url: string, config?: HttpConfig) => request<T>('GET', url, config),
  post: <T = any>(url: string, body?: any, config?: HttpConfig) => request<T>('POST', url, config, body),
  patch: <T = any>(url: string, body?: any, config?: HttpConfig) => request<T>('PATCH', url, config, body),
};

export default http;
