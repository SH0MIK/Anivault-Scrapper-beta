import { Hono } from 'hono';
import { searchMal, resolveSiteIds } from './utils/mapper';
import { cacheStats } from './utils/cache';

import { getHeavenEpisodes, getHeavenServers, getHeavenStream, debugHeavenPage } from './scrapers/animeheaven';
import { getAnikotoEpisodes, getAnikotoServers, getAnikotoEmbedUrl } from './scrapers/anikoto';

const app = new Hono();

const SOURCES = ['animeheaven', 'anikoto'] as const;
type Source = typeof SOURCES[number];

function publicBase(c: any): string {
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0];
  const url = new URL(c.req.url);
  const proto = forwardedProto || url.protocol.replace(':', '');
  const host = c.req.header('host') || url.host;
  return `${proto}://${host}`;
}

function proxiedHlsUrl(c: any, url: string, ref?: string): string {
  const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : '';
  return `${publicBase(c)}/api/proxy/hls?url=${encodeURIComponent(url)}${refParam}`;
}

function proxiedVideoUrl(c: any, url: string): string {
  return `${publicBase(c)}/api/proxy/video?url=${encodeURIComponent(url)}`;
}

function proxiedSubtitleUrl(c: any, url: string, ref?: string): string {
  const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : '';
  return `${publicBase(c)}/api/proxy/subtitle?url=${encodeURIComponent(url)}${refParam}`;
}

function rewriteHlsPlaylist(c: any, body: string, sourceUrl: string, ref?: string): string {
  const base = new URL(sourceUrl);
  return body
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#EXT-X-KEY') && trimmed.includes('URI=')) {
        return line.replace(/URI="([^"]+)"/, (_m, uri) => {
          const absolute = new URL(uri, base).toString();
          return `URI="${proxiedHlsUrl(c, absolute, ref)}"`;
        });
      }
      if (trimmed.startsWith('#')) return line;
      return proxiedHlsUrl(c, new URL(trimmed, base).toString(), ref);
    })
    .join('\n');
}

async function fetchEpisodes(source: Source, siteIds: any, overrides: { heavenId?: string } = {}): Promise<{ episodes: any[]; siteId: string; error?: string }> {
  const heavenId = overrides.heavenId || (siteIds.siteIds?.animeheaven as string | undefined);

  if (source === 'animeheaven') {
    if (!heavenId) return { episodes: [], siteId: '', error: 'Not indexed on AnimeHeaven' };
    return { episodes: await getHeavenEpisodes(heavenId), siteId: heavenId };
  }
  if (source === 'anikoto') {
    const slug = siteIds.siteIds?.anikoto as string | undefined;
    if (!slug) return { episodes: [], siteId: '', error: 'Not indexed on Anikoto' };
    return { episodes: await getAnikotoEpisodes(slug), siteId: slug };
  }
  return { episodes: [], siteId: '', error: 'Unknown source' };
}

app.get('/search', async (c) => {
  const q = c.req.query('q');
  if (!q) return c.json({ error: 'Missing ?q=' }, 400);
  try {
    const results = await searchMal(q);
    return c.json({ query: q, count: results.length, results });
  } catch (e: any) {
    return c.json({ error: 'Search failed', detail: e?.message || String(e), upstream: e?.response?.data ?? null }, 500);
  }
});

app.get('/info', async (c) => {
  const anilistId = c.req.query('anilistId');
  const malId = c.req.query('malId');
  if (!anilistId && !malId) return c.json({ error: 'Provide ?anilistId= or ?malId=' }, 400);
  try {
    const info = await resolveSiteIds(anilistId, malId);
    if (!info) return c.json({ error: 'Anime not found' }, 404);
    return c.json(info);
  } catch (e: any) {
    return c.json({ error: e?.message || String(e), upstream: e?.response?.data ?? null }, 500);
  }
});

app.get('/episodes', async (c) => {
  const anilistId = c.req.query('anilistId');
  const malId = c.req.query('malId');
  const source = (c.req.query('source') || 'animeheaven') as Source;
  const heavenId = c.req.query('heavenId');

  if (!anilistId && !malId && !(source === 'animeheaven' && heavenId)) {
    return c.json({ error: 'Provide ?anilistId= or ?malId=, or ?heavenId= for AnimeHeaven' }, 400);
  }
  if (!SOURCES.includes(source)) return c.json({ error: `source must be: ${SOURCES.join(', ')}` }, 400);

  try {
    if (source === 'animeheaven' && heavenId && !anilistId && !malId) {
      const episodes = await getHeavenEpisodes(heavenId);
      return c.json({ anilistId: null, malId: null, title: null, source, siteId: heavenId, count: episodes.length, episodes });
    }

    const siteIds = await resolveSiteIds(anilistId, malId);
    if (!siteIds) return c.json({ error: 'Anime not found' }, 404);
    const result = await fetchEpisodes(source, siteIds, { heavenId: heavenId || undefined });
    if (result.error) return c.json({ error: result.error }, 404);
    return c.json({
      anilistId: siteIds.anilistId, malId: siteIds.malId, title: siteIds.title, source,
      siteId: result.siteId, count: result.episodes.length, episodes: result.episodes,
    });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e), upstream: e?.response?.data ?? null }, 500);
  }
});

app.get('/servers', async (c) => {
  const anilistId = c.req.query('anilistId');
  const malId = c.req.query('malId');
  const ep = c.req.query('ep');
  const type = c.req.query('type') || 'sub';
  const source = (c.req.query('source') || 'animeheaven') as Source;
  const heavenId = c.req.query('heavenId');

  if (!ep) return c.json({ error: 'Missing ?ep=' }, 400);
  if (!anilistId && !malId && !(source === 'animeheaven' && heavenId)) {
    return c.json({ error: 'Provide ?anilistId= or ?malId=, or ?heavenId= for AnimeHeaven' }, 400);
  }
  const epNum = parseInt(ep);
  if (isNaN(epNum)) return c.json({ error: '?ep must be a number' }, 400);
  if (!SOURCES.includes(source)) return c.json({ error: `source must be: ${SOURCES.join(', ')}` }, 400);

  try {
    const siteIds = heavenId && source === 'animeheaven'
      ? { anilistId: null, malId: null, title: null, siteIds: { animeheaven: heavenId } }
      : await resolveSiteIds(anilistId, malId);
    if (!siteIds) return c.json({ error: 'Could not resolve site IDs' }, 404);

    const epResult = await fetchEpisodes(source, siteIds, { heavenId: heavenId || undefined });
    if (epResult.error) return c.json({ error: epResult.error }, 404);
    const episode = epResult.episodes.find((e: any) => Math.round(e.num) === epNum);
    if (!episode) return c.json({ error: `Episode ${epNum} not found` }, 404);

    let allServers: any[] = [];
    if (source === 'animeheaven') allServers = await getHeavenServers(episode.id);
    if (source === 'anikoto') allServers = await getAnikotoServers(episode.id);

    const filtered = type === 'all' ? allServers : allServers.filter((s: any) => s.type === type);
    return c.json({
      anilistId: siteIds.anilistId,
      malId: siteIds.malId,
      title: siteIds.title,
      episode: epNum,
      type,
      source,
      siteId: epResult.siteId,
      servers: filtered.map((s: any) => ({ name: s.name, sourceId: s.sourceId, type: s.type })),
    });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e), upstream: e?.response?.data ?? null }, 500);
  }
});

async function watchHandler(c: any, source: string, id: string, ep: string, type: string) {
  const preferredServer = c.req.query('server');
  const heavenOverride = c.req.query('heavenId');

  if (!SOURCES.includes(source as Source)) return c.json({ error: `source must be: ${SOURCES.join(', ')}` }, 400);
  const epNum = parseInt(ep);
  if (isNaN(epNum)) return c.json({ error: 'ep must be a number' }, 400);
  if (!['sub', 'dub', 'raw'].includes(type)) return c.json({ error: 'type must be: sub, dub, raw' }, 400);

  // ID convention for this path (site is MAL-first): a bare numeric ID or
  // "mal-<id>" is a MAL ID (primary path, no AniList involved). "al-<id>"
  // opts into the AniList fallback explicitly. Anything else non-numeric on
  // animeheaven is treated as a literal AnimeHeaven slug.
  const forceAnilist = id.startsWith('al-');
  const explicitMal = id.startsWith('mal-');
  const bareNumeric = /^\d+$/.test(id);
  const directHeavenId = source === 'animeheaven' && !forceAnilist && !explicitMal && !bareNumeric;

  const anilistId = forceAnilist ? id.replace('al-', '') : undefined;
  const malId = !forceAnilist && !directHeavenId ? (explicitMal ? id.replace('mal-', '') : id) : undefined;

  try {
    const siteIds = directHeavenId
      ? { anilistId: null, malId: null, title: null, siteIds: { animeheaven: id } }
      : await resolveSiteIds(anilistId, malId);
    if (!siteIds) return c.json({ error: 'Could not resolve anime' }, 404);

    const epResult = await fetchEpisodes(source as Source, siteIds, { heavenId: heavenOverride || undefined });
    if (epResult.error) return c.json({ error: epResult.error }, 404);

    const episode = epResult.episodes.find((e: any) => Math.round(e.num) === epNum);
    if (!episode) return c.json({ error: `Episode ${epNum} not found` }, 404);

    let allServers: any[] = [];
    if (source === 'animeheaven') allServers = await getHeavenServers(episode.id);
    if (source === 'anikoto') allServers = await getAnikotoServers(episode.id);

    const filtered = allServers.filter((s: any) => s.type === type);
    if (!filtered.length) return c.json({ error: `No ${type} stream available on ${source} for ep ${epNum}` }, 404);

    const strict = c.req.query('strict') === '1' || c.req.query('strict') === 'true';
    let candidates = filtered;
    if (preferredServer && strict) {
      candidates = filtered.filter((s: any) => s.name.toLowerCase().includes(preferredServer.toLowerCase()));
      if (!candidates.length) {
        return c.json({ error: `No server matching "${preferredServer}" found`, availableServers: filtered.map((s: any) => s.name) }, 404);
      }
    } else if (preferredServer) {
      candidates = [...filtered].sort((a: any, b: any) => {
        const aM = a.name.toLowerCase().includes(preferredServer.toLowerCase()) ? -1 : 1;
        const bM = b.name.toLowerCase().includes(preferredServer.toLowerCase()) ? -1 : 1;
        return aM - bM;
      });
    }

    let embedResult: any = null;
    let usedServer = '';
    for (const server of candidates) {
      let raw: any = null;
      if (source === 'animeheaven') raw = await getHeavenStream(server.sourceId);
      if (source === 'anikoto') raw = await getAnikotoEmbedUrl(server.sourceId);
      if (raw) { embedResult = raw; usedServer = server.name; break; }
    }
    if (!embedResult) {
      const msg = strict && preferredServer ? `Server "${preferredServer}" failed to resolve a stream` : 'All servers failed';
      return c.json({ error: msg, triedServers: candidates.map((s: any) => s.name) }, 502);
    }

    if (source === 'animeheaven') {
      return c.json({
        anilistId: siteIds.anilistId,
        malId: siteIds.malId,
        title: siteIds.title,
        episode: epNum,
        type,
        source,
        siteId: epResult.siteId,
        server: usedServer,
        availableServers: filtered.map((s: any) => s.name),
        embedUrl: embedResult.embedUrl,
        streamUrl: proxiedVideoUrl(c, embedResult.streamUrl),
        rawStreamUrl: embedResult.streamUrl,
        mp4: embedResult.mp4,
        mp4ProxyUrl: proxiedVideoUrl(c, embedResult.mp4),
        m3u8: null,
        hlsProxyUrl: null,
        playbackMode: 'mp4',
        iframeOnly: false,
        subtitles: [],
        note: 'AnimeHeaven currently exposes direct MP4 sources, not m3u8/HLS.',
      });
    }

    // anikoto is the only remaining non-animeheaven source at this point.
    return c.json({
      anilistId: siteIds.anilistId,
      malId: siteIds.malId,
      title: siteIds.title,
      episode: epNum,
      type,
      source,
      server: usedServer,
      availableServers: filtered.map((s: any) => s.name),
      embedUrl: embedResult.embedUrl,
      m3u8: embedResult.m3u8 ?? null,
      hlsProxyUrl: embedResult.m3u8 ? proxiedHlsUrl(c, embedResult.m3u8, embedResult.referer) : null,
      playbackMode: embedResult.m3u8 ? 'hls' : 'iframe',
      iframeOnly: !embedResult.m3u8,
      subtitles: (embedResult.subtitles ?? []).map((s: any) => ({
        ...s,
        url: proxiedSubtitleUrl(c, s.url, embedResult.referer),
      })),
      intro: null,
      outro: null,
      note: embedResult.m3u8 ? null : 'No m3u8 extracted — use embedUrl in an iframe.',
    });
  } catch (e) {
    console.error(`[/watch/${source}]`, e);
    return c.json({ error: 'Stream fetch failed', detail: String(e) }, 500);
  }
}

app.get('/watch', async (c) => {
  const anilistId = c.req.query('anilistId');
  const malId = c.req.query('malId');
  const heavenId = c.req.query('heavenId');
  const ep = c.req.query('ep');
  const type = c.req.query('type') || 'sub';
  const source = c.req.query('source') || 'animeheaven';

  if (!ep) return c.json({ error: 'Missing ?ep=' }, 400);
  if (!anilistId && !malId && !(source === 'animeheaven' && heavenId)) {
    return c.json({ error: 'Provide ?anilistId= or ?malId=, or ?heavenId= for AnimeHeaven' }, 400);
  }
  const id = heavenId && source === 'animeheaven' ? String(heavenId) : anilistId ? `al-${anilistId}` : `mal-${malId}`;
  return watchHandler(c, source, id, String(ep), type);
});

app.get('/watch/:source/:id/:ep/:type', async (c) => {
  const { source, id, ep, type } = c.req.param();
  return watchHandler(c, source, id, ep, type);
});

app.get('/proxy/hls', async (c) => {
  const url = c.req.query('url');
  const ref = c.req.query('ref');
  if (!url) return c.json({ error: 'Missing ?url=' }, 400);
  if (!/^https?:\/\//i.test(url)) return c.json({ error: '?url must be absolute http(s)' }, 400);

  let referer: string | undefined;
  let origin: string | undefined;
  if (ref && /^https?:\/\//i.test(ref)) {
    referer = ref;
    try {
      origin = new URL(ref).origin;
    } catch {
      origin = undefined;
    }
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(referer ? { Referer: referer } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
    });
    if (!upstream.ok) {
      return c.json({ error: 'HLS proxy failed', detail: `upstream status ${upstream.status}` }, 502);
    }

    const contentType = upstream.headers.get('content-type') || '';
    const buf = await upstream.arrayBuffer();
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Cache-Control', 'public, max-age=30');

    if (url.includes('.m3u8') || contentType.includes('mpegurl')) {
      const text = new TextDecoder().decode(buf);
      if (!text.trim().startsWith('#EXTM3U')) {
        return c.json({ error: 'Upstream did not return a valid m3u8 playlist', body: text.slice(0, 300) }, 502);
      }
      c.header('Content-Type', 'application/vnd.apple.mpegurl');
      return c.body(rewriteHlsPlaylist(c, text, url, ref));
    }

    c.header('Content-Type', contentType || 'application/octet-stream');
    return c.body(buf);
  } catch (e: any) {
    return c.json({ error: 'HLS proxy failed', detail: e?.message || String(e) }, 502);
  }
});

app.get('/proxy/subtitle', async (c) => {
  const url = c.req.query('url');
  const ref = c.req.query('ref');
  if (!url) return c.json({ error: 'Missing ?url=' }, 400);
  if (!/^https?:\/\//i.test(url)) return c.json({ error: '?url must be absolute http(s)' }, 400);

  let referer: string | undefined;
  let origin: string | undefined;
  if (ref && /^https?:\/\//i.test(ref)) {
    referer = ref;
    try {
      origin = new URL(ref).origin;
    } catch {
      origin = undefined;
    }
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(referer ? { Referer: referer } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
    });
    if (!upstream.ok) {
      return c.json({ error: 'Subtitle proxy failed', detail: `upstream status ${upstream.status}` }, upstream.status as any);
    }

    let text = await upstream.text();
    if (!text.trim().startsWith('WEBVTT')) {
      text = 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    }

    c.header('Access-Control-Allow-Origin', '*');
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Content-Type', 'text/vtt');
    return c.body(text);
  } catch (e: any) {
    return c.json({ error: 'Subtitle proxy failed', detail: e?.message || String(e) }, 502);
  }
});

app.get('/proxy/video', async (c) => {
  const url = c.req.query('url');
  if (!url) return c.json({ error: 'Missing ?url=' }, 400);
  if (!/^https?:\/\//i.test(url)) return c.json({ error: '?url must be absolute http(s)' }, 400);

  try {
    const range = c.req.header('range');
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*',
        'Referer': 'https://animeheaven.me/',
        'Origin': 'https://animeheaven.me',
        ...(range ? { Range: range } : {}),
      },
    });

    if (!upstream.ok && upstream.status !== 206) {
      return c.json({ error: 'Video proxy failed', detail: `upstream status ${upstream.status}` }, 502);
    }

    const headers = new Headers();
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
    headers.set('Cache-Control', upstream.headers.get('cache-control') || 'public, max-age=3600');
    for (const h of ['content-type', 'content-length', 'content-range', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }

    // Stream the body straight through instead of buffering it — this is
    // the Workers equivalent of axios's `upstream.data.pipe(res)`.
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e: any) {
    return c.json({ error: 'Video proxy failed', detail: e?.message || String(e) }, 502);
  }
});

// Temporary diagnostic — remove once the AnimeHeaven episode-scraping issue
// is confirmed fixed. GET /api/debug/heaven?id=<heavenId>
app.get('/debug/heaven', async (c) => {
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'Missing ?id=' }, 400);
  try {
    const info = await debugHeavenPage(id);
    return c.json(info);
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 500);
  }
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: '1.1.0-anikoto',
    sources: SOURCES,
    cache: cacheStats(),
    timestamp: new Date().toISOString(),
  });
});

export default app;
