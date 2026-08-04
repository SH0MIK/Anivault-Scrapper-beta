import * as cheerio from 'cheerio';
import axios from 'axios';
import { inspect } from 'util';
import { makeClient, makeAjaxClient } from '../utils/fetch';
import { cacheGet, cacheSet } from '../utils/cache';

// ══════════════════════════════════════════════════════════════
// ANIKOTO.NET — HiAnime/Zoro-style clone
//   /watch/{slug}              → episode list page
//   /ajax/episode/list/{id}    → episode list fragment (AJAX fallback)
//   /ajax/server/list?servers= → server list fragment
//   /ajax/server?get=&sv=      → resolves a server to its embed URL
//   + a "Kiwi Mapper" side-channel keyed by MAL id, independent of the
//     regular server list, that points at a CDN not behind bot-protection.
// ══════════════════════════════════════════════════════════════

const BASE = 'https://anikoto.net';
const http = makeClient(BASE, BASE + '/');
const ajax = makeAjaxClient(BASE, BASE + '/');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Matches anikoto-API's own DEFAULT_HEADERS exactly — keeping this in lockstep
// with the reference implementation avoids fingerprint-based failures that are
// otherwise very hard to diagnose without live access to the site.
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
  'Cache-Control': 'no-cache',
  Referer: BASE + '/',
};

const KIWI_MAPPER_URLS = [
  'https://mapper.nekostream.site/api/mal',
  'https://mapper.mewcdn.online/api/mal',
];

// Every failure point in the embed-resolution chain below logs through this,
// so a "not playable" report can be traced to an exact step from Railway logs
// instead of just a silent null. Grep for "[anikoto]".
// IMPORTANT: uses util.inspect with depth:null — plain console.error(obj)
// truncates nested objects at depth 2, which previously hid exactly the
// field we needed to see (the Kiwi mapper's nested `download` shape).
function log(label: string, extra?: any) {
  if (extra !== undefined) console.error(`[anikoto] ${label}`, inspect(extra, { depth: null, colors: false, maxArrayLength: 20 }));
  else console.error(`[anikoto] ${label}`);
}

function errInfo(err: any): any {
  if (err?.isAxiosError) {
    return {
      status: err.response?.status,
      statusText: err.response?.statusText,
      url: err.config?.url,
      body: typeof err.response?.data === 'string' ? err.response.data.slice(0, 300) : err.response?.data,
    };
  }
  return err instanceof Error ? err.message : err;
}

export interface AnikotoEpisode {
  num: number;
  id: string;
  title: string;
}

export interface AnikotoServer {
  name: string;
  sourceId: string;
  type: 'sub' | 'dub' | 'raw';
}

export interface AnikotoSubtitle {
  lang: string;
  url: string;
  default?: boolean;
}

export interface AnikotoStream {
  embedUrl: string;
  m3u8: string | null;
  referer?: string;
  subtitles: AnikotoSubtitle[];
  serverName: string;
  type: 'hls' | 'iframe';
}

// ══════════════════════════════════════════════════════════════
// SEARCH / SLUG RESOLUTION (no AniList mapping exists for anikoto,
// so — same approach as AnimeHeaven — we search by title and score
// the closest match).
// ══════════════════════════════════════════════════════════════

interface AnikotoSearchResult {
  slug: string;
  title: string;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function scoreTitle(query: string, title: string): number {
  const needle = normalizeTitle(query);
  const hay = normalizeTitle(title);
  if (!needle || !hay) return 0;
  if (hay === needle) return 100;
  if (hay.startsWith(needle) || needle.startsWith(hay)) return 80;
  if (hay.includes(needle) || needle.includes(hay)) return 60;
  let matches = 0;
  for (const ch of needle) if (hay.includes(ch)) matches++;
  return Math.floor((matches / Math.max(needle.length, 1)) * 40);
}

export async function searchAnikoto(query: string): Promise<AnikotoSearchResult[]> {
  const cacheKey = `anikoto:search:${query.toLowerCase().trim()}`;
  const cached = cacheGet<AnikotoSearchResult[]>(cacheKey);
  if (cached) return cached;

  const res = await http.get('/filter', { params: { keyword: query } });
  const $ = cheerio.load(res.data);
  const results: AnikotoSearchResult[] = [];

  $('.items.flw-wrap .film_list-wrap .flw-item, .film_list-wrap .flw-item, .ani.items .item, section .items .item').each(
    (_, el) => {
      const $el = $(el);
      const href = $el.attr('href') ?? $el.find('a').first().attr('href') ?? '';
      const slug = href
        .replace(/^https?:\/\/[^/]+/, '')
        .replace(/^\/watch\//, '')
        .replace(/\/ep-\d+$/, '')
        .replace(/\/$/, '');
      const title = $el.find('.name, .d-title').first().text().trim();
      if (!slug || !title) return;
      results.push({ slug, title });
    }
  );

  cacheSet(cacheKey, results, 'episodes');
  return results;
}

export async function findAnikotoSlug(title: string): Promise<string | null> {
  const noPossessive = title.replace(/[’']s\b/gi, '');
  const variants = Array.from(
    new Set(
      [
        title,
        noPossessive,
        title.replace(/[’']/g, ''),
        noPossessive.replace(/[+]/g, ' '),
        title.replace(/[+]/g, ' '),
        title.split(/[:(|-]/)[0]?.trim(),
        noPossessive.split(/[:(|-]/)[0]?.trim(),
        title.replace(/[’']/g, '').split(/\s+/).slice(0, 2).join(' '),
        noPossessive.split(/\s+/).slice(0, 2).join(' '),
        title.replace(/[’']/g, '').split(/\s+/)[0],
        noPossessive.split(/\s+/)[0],
      ].filter((value): value is string => Boolean(value && value.trim().length >= 3))
    )
  );

  const allResults: AnikotoSearchResult[] = [];
  for (const variant of variants) {
    const results = await searchAnikoto(variant).catch(() => []);
    allResults.push(...results);
    if (results.some((result) => scoreTitle(title, result.title) >= 80)) break;
  }

  const unique = Array.from(new Map(allResults.map((result) => [result.slug, result])).values());
  if (!unique.length) return null;
  return unique.map((result) => ({ result, score: scoreTitle(title, result.title) })).sort((a, b) => b.score - a.score)[0]
    .result.slug;
}

// ══════════════════════════════════════════════════════════════
// EPISODE LIST
// ══════════════════════════════════════════════════════════════

interface RawEpisode {
  num: number;
  title: string;
  dataIds?: string;
  dataMal?: string;
  dataTimestamp?: string;
}

async function fetchRawEpisodes(slug: string): Promise<RawEpisode[]> {
  const cacheKey = `anikoto:eps:${slug}`;
  const cached = cacheGet<RawEpisode[]>(cacheKey);
  if (cached) return cached;

  const res = await http.get(`/watch/${slug}`);
  const $ = cheerio.load(res.data);
  const animeId = $('#watch-main').attr('data-id') ?? '';

  // If episodes aren't inlined in the page, the site lazy-loads them via AJAX
  if (animeId && $('#w-episodes a').length === 0) {
    try {
      const data = await ajax.get(`/ajax/episode/list/${animeId}`);
      const result = data.data?.result;
      if (result) {
        const ajaxDoc = cheerio.load(result);
        $('#w-episodes').html(ajaxDoc.root().html() || '');
      }
    } catch {
      // fall through with whatever (possibly empty) the page already had
    }
  }

  const episodes: RawEpisode[] = [];
  $('#w-episodes ul.ep-range li a, #w-episodes a[href], #w-episodes a[data-num]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') ?? '';
    if (!href.includes('/watch/') && !$el.attr('data-num')) return;

    const epNumRaw =
      $el.attr('data-num') || $el.find('.number, .d-title, span').first().text().trim() || href.split('/ep-')[1] || '';
    const num = parseFloat(epNumRaw);
    if (!Number.isFinite(num)) return;

    episodes.push({
      num,
      title: $el.attr('title')?.trim() || `Episode ${epNumRaw}`,
      dataIds: $el.attr('data-ids') ?? $el.attr('data-id') ?? undefined,
      dataMal: $el.attr('data-mal') ?? undefined,
      dataTimestamp: $el.attr('data-timestamp') ?? undefined,
    });
  });

  const unique = Array.from(new Map(episodes.map((ep) => [ep.num, ep])).values()).sort((a, b) => a.num - b.num);
  if (unique.length > 0) cacheSet(cacheKey, unique, 'episodes');
  return unique;
}

export async function getAnikotoEpisodes(slug: string): Promise<AnikotoEpisode[]> {
  const raw = await fetchRawEpisodes(slug);
  return raw.map((ep) => ({
    num: ep.num,
    // sourceId for getAnikotoServers() — carries everything needed to fetch
    // the server list (data-ids) and the Kiwi side-channel (data-mal + data-timestamp)
    // without a second page fetch.
    id: `${slug}::${ep.num}::${ep.dataIds ?? ''}::${ep.dataMal ?? ''}::${ep.dataTimestamp ?? ''}`,
    title: ep.title,
  }));
}

// ══════════════════════════════════════════════════════════════
// SERVER LIST
// ══════════════════════════════════════════════════════════════

export async function getAnikotoServers(episodeId: string): Promise<AnikotoServer[]> {
  const [slug, epNumStr, dataIds, dataMal, dataTimestamp] = episodeId.split('::');
  if (!slug || !epNumStr) {
    log('getAnikotoServers: malformed episodeId', episodeId);
    return [];
  }

  const servers: AnikotoServer[] = [];

  if (dataIds) {
    try {
      const res = await ajax.get('/ajax/server/list', { params: { servers: dataIds } });
      const html = res.data?.result || (typeof res.data === 'string' ? res.data : '');
      const $ = cheerio.load(html);

      $('.server, li').each((_, el) => {
        const $el = $(el);
        const linkId = $el.attr('data-link-id');
        if (!linkId) return;

        const typeLabel = $el.closest('.type').find('label, .name').text().trim().toLowerCase();
        const name = $el.text().trim() || 'Server';
        const svId = $el.attr('data-sv-id') || '';
        const type: AnikotoServer['type'] =
          typeLabel.includes('dub') ? 'dub' : typeLabel.includes('raw') ? 'raw' : 'sub';

        servers.push({
          name,
          sourceId: `${slug}::${epNumStr}::reg::${linkId}::${svId}::${encodeURIComponent(name)}`,
          type,
        });
      });

      if (servers.length === 0) {
        log('getAnikotoServers: /ajax/server/list returned no parseable .server/li elements', { slug, dataIds, htmlSnippet: String(html).slice(0, 300) });
      }
    } catch (err) {
      log('getAnikotoServers: /ajax/server/list threw', { slug, dataIds, ...errInfo(err) });
    }
  }

  // Kiwi Mapper side-channel — independent CDN, requires MAL id + timestamp
  if (dataMal && dataTimestamp) {
    for (const type of ['sub', 'dub'] as const) {
      servers.push({
        name: `Kiwi Stream (${type})`,
        sourceId: `kiwi::${dataMal}::${epNumStr}::${dataTimestamp}::${type}`,
        type,
      });
    }
  }

  return servers;
}

// ══════════════════════════════════════════════════════════════
// EMBED / STREAM RESOLUTION
// ══════════════════════════════════════════════════════════════

async function parseM3u8Subtitles(m3u8Url: string, referer: string): Promise<AnikotoSubtitle[]> {
  try {
    const { data } = await axios.get<string>(m3u8Url, {
      headers: { ...DEFAULT_HEADERS, Referer: referer },
      timeout: 5000,
    });
    const tracks: AnikotoSubtitle[] = [];
    for (const line of data.split('\n')) {
      if (!line.startsWith('#EXT-X-MEDIA') || !line.includes('TYPE=SUBTITLES')) continue;
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      if (!uri) continue;
      const label = line.match(/NAME="([^"]+)"/)?.[1];
      const isDefault = /DEFAULT=YES/i.test(line);
      const fullUri = uri.startsWith('http') ? uri : new URL(uri, m3u8Url).toString();
      tracks.push({ url: fullUri, lang: label || 'Unknown', default: isDefault });
    }
    return tracks;
  } catch {
    return [];
  }
}

// The mapper's documented shape is `{ [server]: { sub: { url } } }`, but live
// responses have been observed nesting the actual code one level deeper under
// `download` (e.g. `{ sub: { download: { url } } }` or keyed by quality under
// `download`). This checks the direct shape first, then probes one level into
// `download` for anything that looks like a server code.
function extractServerCode(entry: any): string | null {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.url === 'string') return entry.url;

  const nested = entry.download;
  if (nested) {
    if (typeof nested === 'string') return nested;
    if (typeof nested === 'object') {
      if (typeof nested.url === 'string') return nested.url;
      for (const v of Object.values(nested)) {
        if (typeof v === 'string') return v;
        if (v && typeof v === 'object' && typeof (v as any).url === 'string') return (v as any).url;
      }
    }
  }
  return null;
}

// A real anikoto `data-link-id` server code is a short opaque token, never a
// full URL. The mapper's `download` field, by contrast, IS a full URL (a
// download-shortlink), and feeding that into `/ajax/server?get=` is a
// category error — anikoto correctly 400s it. This distinguishes the two.
function looksLikeServerCode(s: string): boolean {
  return typeof s === 'string' && s.length > 0 && !/^https?:\/\//i.test(s);
}

// ── Kiwi Mapper ──────────────────────────────────────────────
async function resolveKiwi(malId: string, epNum: string, timestamp: string, type: 'sub' | 'dub'): Promise<AnikotoStream | null> {
  for (const mapperBase of KIWI_MAPPER_URLS) {
    try {
      const mapperUrl = `${mapperBase}/${encodeURIComponent(malId)}/${encodeURIComponent(epNum)}/${encodeURIComponent(timestamp)}`;
      const { data } = await axios.get(mapperUrl, {
        headers: { ...DEFAULT_HEADERS, Referer: BASE + '/', Origin: BASE },
        timeout: 8000,
      });
      if (!data || typeof data !== 'object') {
        log(`kiwi: ${mapperBase} returned non-object`, data);
        continue;
      }

      let serverCode: string | null = null;
      let directUrl: string | null = null;
      for (const key of Object.keys(data)) {
        if (key === 'status') continue;
        const entry = data[key]?.[type];
        if (!entry) continue;
        // Always logged (full depth) — even on success — so the exact live
        // shape is on record without needing another guess-and-redeploy loop.
        log(`kiwi: entry for ${key}.${type}`, entry);

        if (typeof entry.url === 'string') {
          if (looksLikeServerCode(entry.url)) {
            serverCode = entry.url;
            break;
          }
          directUrl = directUrl ?? entry.url;
        }
        if (!serverCode) {
          const fromDownload = extractServerCode(entry);
          if (fromDownload && looksLikeServerCode(fromDownload)) {
            serverCode = fromDownload;
            break;
          } else if (fromDownload) {
            directUrl = directUrl ?? fromDownload;
          }
        }
      }

      // Path A: a real anikoto server code — resolve through /ajax/server?get=
      if (serverCode) {
        const serverRes = await ajax.get('/ajax/server', { params: { get: serverCode } });
        let embedUrl: string | null = serverRes.data?.result?.url ?? null;
        if (!embedUrl) {
          log('kiwi: /ajax/server?get= returned no url for server code', { serverCode, response: serverRes.data });
        } else {
          if (embedUrl.includes('#')) {
            try {
              embedUrl = Buffer.from(embedUrl.split('#')[1], 'base64').toString('utf-8');
            } catch (err) {
              log('kiwi: base64 decode of embedUrl fragment failed', errInfo(err));
            }
          }
          const referer = 'https://kwik.cx2.mewcdn.online/';
          const subtitles = await parseM3u8Subtitles(embedUrl, referer);
          log(`kiwi: resolved via ${mapperBase} (server-code path)`, { embedUrl });
          return { embedUrl, m3u8: embedUrl, referer, subtitles, serverName: 'Kiwi Stream', type: 'hls' };
        }
      }

      // Path B: no valid server code, but a direct URL was found (e.g. the
      // `download` shortlink) — run it through the normal extractor chain in
      // case it happens to resolve to a known megacloud/megaplay host.
      if (directUrl) {
        log('kiwi: no valid server code, trying direct link through extractor chain', { directUrl });
        const resolved = await resolveAnikotoEmbed(directUrl, 'Kiwi Stream').catch((err) => {
          log('kiwi: direct link resolution threw', errInfo(err));
          return null;
        });
        if (resolved) {
          log(`kiwi: resolved via ${mapperBase} (direct-link path)`, { directUrl, m3u8: resolved.m3u8 });
          return resolved;
        }
        log('kiwi: direct link did not resolve via any known extractor', { directUrl });
      }

      if (!serverCode && !directUrl) {
        log(`kiwi: ${mapperBase} had no usable "${type}" entry at all`, data);
      }
    } catch (err) {
      log(`kiwi: ${mapperBase} threw`, errInfo(err));
    }
  }
  log('kiwi: all mapper mirrors failed');
  return null;
}

// ── Vidstream / VidPlay (domain2_url + save_data.php pattern) ──
// anikoto's reference implementation tries this FIRST for any server whose
// name contains "vidstream", "vidplay", or "vid-", before falling back to
// the standard megacloud/megaplay chain below.
async function resolveVidstream(embedUrl: string, referer: string): Promise<AnikotoStream | null> {
  try {
    const { data: html } = await axios.get<string>(embedUrl, {
      headers: { ...DEFAULT_HEADERS, Referer: referer },
      timeout: 8000,
    });

    const epIdMatch = html.match(/data-ep-id=["'](\d+)["']/);
    const typeMatch = html.match(/type:\s*'(\w+)'/);
    const domain2Match = html.match(/domain2_url:\s*'([^']+)'/);
    if (!epIdMatch || !typeMatch || !domain2Match) {
      log('vidstream: regex miss on embed page', {
        embedUrl,
        hasEpId: Boolean(epIdMatch),
        hasType: Boolean(typeMatch),
        hasDomain2: Boolean(domain2Match),
        htmlSnippet: html.slice(0, 300),
      });
      return null;
    }

    const epId = epIdMatch[1];
    const epType = typeMatch[1];
    const domain2 = domain2Match[1].trim();

    const saveDataUrl = `${domain2}/save_data.php?id=${epId}-${epType}`;
    const { data } = await axios.get(saveDataUrl, {
      headers: { ...DEFAULT_HEADERS, Referer: referer },
      timeout: 8000,
    });

    const sources = data?.data?.sources ?? [];
    const subtitles: AnikotoSubtitle[] = (data?.data?.tracks ?? [])
      .filter((t: any) => t?.file)
      .map((t: any) => ({ url: t.file, lang: t.label ?? 'Unknown', default: Boolean(t.default) }));
    const m3u8: string | undefined = sources[0]?.url;
    if (!m3u8) {
      log('vidstream: save_data.php had no sources', { saveDataUrl, data });
      return null;
    }

    log('vidstream: resolved', { embedUrl, m3u8 });
    return { embedUrl, m3u8, referer: domain2 + '/', subtitles, serverName: 'Vidstream', type: 'hls' };
  } catch (err) {
    log('vidstream: threw', { embedUrl, ...errInfo(err) });
    return null;
  }
}

// ── Megacloud (anikoto's current embed host: megacloud.blog) ───
let _megacloudKeysCache: Record<string, string> | null = null;
let _megacloudKeysCacheAt = 0;
const MEGACLOUD_KEYS_TTL_MS = 15 * 60 * 1000;

async function getMegacloudKeys(): Promise<Record<string, string>> {
  const now = Date.now();
  if (_megacloudKeysCache && now - _megacloudKeysCacheAt < MEGACLOUD_KEYS_TTL_MS) return _megacloudKeysCache;
  const { data } = await axios.get<Record<string, string>>(
    'https://raw.githubusercontent.com/yogesh-hacker/MegacloudKeys/refs/heads/main/keys.json',
    { timeout: 5000 }
  );
  _megacloudKeysCache = data;
  _megacloudKeysCacheAt = now;
  return data;
}

async function doMegacloud(embedUrl: string, html: string, referer: string, serverName: string): Promise<AnikotoStream | null> {
  try {
    const origin = new URL(embedUrl).origin;

    const match1 = html.match(/\b[a-zA-Z0-9]{48}\b/);
    const match2 = html.match(/\b([a-zA-Z0-9]{16})\b.*?\b([a-zA-Z0-9]{16})\b.*?\b([a-zA-Z0-9]{16})\b/);
    const nonce = match1?.[0] || (match2 ? match2[1] + match2[2] + match2[3] : null);
    if (!nonce) {
      log('megacloud: no nonce found in embed HTML', { embedUrl, htmlSnippet: html.slice(0, 300) });
      return null;
    }

    const sId = embedUrl.split('/e-1/')[1]?.split('?')[0] ?? embedUrl.split('/').pop()?.split('?')[0];
    const sourcesUrl = `${origin}/embed-2/v3/e-1/getSources?id=${sId}&_k=${nonce}`;

    const { data } = await axios.get(sourcesUrl, {
      headers: { ...DEFAULT_HEADERS, Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest', Referer: referer },
      timeout: 8000,
    });

    const subtitles: AnikotoSubtitle[] = (data?.tracks || [])
      .filter((t: any) => t?.file)
      .map((t: any) => ({ url: t.file, lang: t.label ?? 'Unknown', default: Boolean(t.default) }));

    let m3u8: string | null = null;
    if (!data?.encrypted || data?.sources?.[0]?.file?.includes('.m3u8')) {
      m3u8 = data?.sources?.[0]?.file ?? null;
      if (!m3u8) log('megacloud: getSources returned no usable sources', { sourcesUrl, data });
    } else {
      try {
        const keys = await getMegacloudKeys();
        const secret = keys['mega'];
        if (!secret) log('megacloud: "mega" key missing from MegacloudKeys/keys.json', keys);
        const decryptUrl =
          `https://megacloud-api-nine.vercel.app/` +
          `?encrypted_data=${encodeURIComponent(data.sources[0].file)}` +
          `&nonce=${encodeURIComponent(nonce)}` +
          `&secret=${encodeURIComponent(secret)}`;
        const { data: decrypted } = await axios.get(decryptUrl, { timeout: 8000 });
        m3u8 = (typeof decrypted === 'string' ? decrypted : JSON.stringify(decrypted)).match(/"file":"(.*?)"/)?.[1] ?? null;
        if (!m3u8) log('megacloud: decrypt API returned no "file"', decrypted);
      } catch (err) {
        log('megacloud: decrypt step threw', errInfo(err));
        m3u8 = null;
      }
    }

    if (!m3u8) return null;
    log('megacloud: resolved', { embedUrl, m3u8 });
    return { embedUrl, m3u8, referer, subtitles, serverName, type: 'hls' };
  } catch (err) {
    log('megacloud: threw', { embedUrl, ...errInfo(err) });
    return null;
  }
}

// ── Megaplay (megaplay.buzz / vidwish.live / vidtube.site mirrors) ──
async function doMegaplay(host: string, html: string, referer: string, serverName: string): Promise<AnikotoStream | null> {
  const match = html.match(/<title>File ([0-9]+)/);
  if (!match) {
    log('megaplay: no "<title>File N" match — page may not be a megaplay player', { host, htmlSnippet: html.slice(0, 300) });
    return null;
  }
  const id = match[1];

  try {
    const { data } = await axios.get(`https://${host}/stream/getSources?id=${id}`, {
      headers: { ...DEFAULT_HEADERS, 'X-Requested-With': 'XMLHttpRequest', Referer: referer },
      timeout: 8000,
    });

    let m3u8: string | undefined = data?.sources?.file;
    const subtitles: AnikotoSubtitle[] = (data?.tracks || [])
      .filter((t: any) => t?.file)
      .map((t: any) => ({ url: t.file, lang: t.label ?? 'Unknown', default: Boolean(t.default) }));

    if (m3u8 && m3u8.includes('mewstream.buzz')) {
      const original = m3u8;
      let replacementHost = '1oe.lostproject.club';
      let source: 'subtitle-derived' | 'hardcoded-fallback' = 'hardcoded-fallback';
      const firstTrack = subtitles.find((t) => t.url && !t.url.includes('mewstream.buzz'));
      if (firstTrack) {
        try {
          replacementHost = new URL(firstTrack.url).host;
          source = 'subtitle-derived';
        } catch {
          // keep default fallback host
        }
      }
      try {
        const parsed = new URL(m3u8);
        parsed.host = replacementHost;
        m3u8 = parsed.toString();
        log('megaplay: rewrote mewstream.buzz host', { host, id, original, rewritten: m3u8, replacementHost, source });
      } catch (err) {
        log('megaplay: mewstream.buzz host rewrite failed, keeping original (likely dead) url', { host, id, original, ...errInfo(err) });
      }
    }

    if (!m3u8) {
      log('megaplay: getSources returned no sources.file', { host, id, data });
      return null;
    }
    log('megaplay: resolved', { host, id, m3u8 });
    return { embedUrl: `https://${host}/`, m3u8, referer, subtitles, serverName, type: 'hls' };
  } catch (err) {
    log('megaplay: getSources threw', { host, id, ...errInfo(err) });
    return null;
  }
}

// ── Generic chain: follow the embed page (and any nested iframe) until it
//    resolves to a known megacloud/megaplay host, mirroring anikoto's own
//    extractStreamUrl chain so domain rotations stay handled the same way.
async function resolveAnikotoEmbed(embedUrl: string, serverName: string): Promise<AnikotoStream | null> {
  try {
    const hostname = new URL(embedUrl).hostname;

    if (hostname.includes('megaplay.buzz') || hostname.includes('vidwish.live') || hostname.includes('megacloud.bloggy.click')) {
      const url = embedUrl.replace('vidwish.live', 'megaplay.buzz').replace('megacloud.bloggy.click', 'megaplay.buzz');
      const host = new URL(url).host;
      const referer = `https://${host}/`;
      const { data: html } = await axios.get<string>(url, { headers: { ...DEFAULT_HEADERS, Referer: referer }, timeout: 8000 });
      return doMegaplay(host, html, referer, serverName);
    }

    if (hostname.includes('megacloud.blog')) {
      const referer = new URL(embedUrl).origin + '/';
      const { data: html } = await axios.get<string>(embedUrl, { headers: { ...DEFAULT_HEADERS, Referer: referer }, timeout: 8000 });
      return doMegacloud(embedUrl, html, referer, serverName);
    }

    if (hostname.includes('vidtube.site')) {
      const host = new URL(embedUrl).host;
      const referer = `https://${host}/`;
      const { data: html } = await axios.get<string>(embedUrl, { headers: { ...DEFAULT_HEADERS, Referer: referer }, timeout: 8000 });
      return doMegaplay(host, html, referer, serverName);
    }

    // Unknown host — follow one redirect hop via an <iframe> if present, then give up.
    let currentUrl = embedUrl;
    for (let i = 0; i < 2; i++) {
      let host = new URL(currentUrl).host;
      let referer = `https://${host}/`;
      let html: string;
      try {
        const res = await axios.get<string>(currentUrl, { headers: { ...DEFAULT_HEADERS, Referer: referer }, timeout: 8000 });
        html = res.data;
        // axios/Node follow redirects transparently — `currentUrl` would
        // otherwise stay at the pre-redirect address, so a 30x straight to a
        // known host (megaplay.buzz, etc.) would be missed entirely below.
        const resolvedUrl: string | undefined = (res.request as any)?.res?.responseUrl;
        if (resolvedUrl && resolvedUrl !== currentUrl) {
          log('resolveAnikotoEmbed: followed redirect', { from: currentUrl, to: resolvedUrl });
          currentUrl = resolvedUrl;
        }
      } catch (err) {
        log('resolveAnikotoEmbed: unknown-host fetch threw', { currentUrl, ...errInfo(err) });
        return null;
      }

      const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (iframeMatch) {
        const resolved = new URL(iframeMatch[1], currentUrl).toString();
        if (resolved !== currentUrl) {
          currentUrl = resolved;
          continue;
        }
      }

      const finalHost = new URL(currentUrl).hostname;
      if (finalHost.includes('megaplay.buzz') || finalHost.includes('vidwish.live') || finalHost.includes('vidtube.site')) {
        return doMegaplay(new URL(currentUrl).host, html, `https://${new URL(currentUrl).host}/`, serverName);
      }
      if (finalHost.includes('megacloud.blog')) {
        return doMegacloud(currentUrl, html, `https://${new URL(currentUrl).host}/`, serverName);
      }
      log('resolveAnikotoEmbed: unrecognized host, no known extractor', { serverName, originalEmbedUrl: embedUrl, finalHost, htmlSnippet: html.slice(0, 300) });
      return null;
    }
    log('resolveAnikotoEmbed: gave up after iframe-follow limit', { serverName, originalEmbedUrl: embedUrl, currentUrl });
    return null;
  } catch (err) {
    log('resolveAnikotoEmbed: threw', { serverName, embedUrl, ...errInfo(err) });
    return null;
  }
}

export async function getAnikotoEmbedUrl(sourceId: string): Promise<AnikotoStream | null> {
  const parts = sourceId.split('::');

  if (parts[0] === 'kiwi') {
    const [, malId, epNum, timestamp, type] = parts;
    if (!malId || !epNum || !timestamp) {
      log('getAnikotoEmbedUrl: malformed kiwi sourceId', sourceId);
      return null;
    }
    return resolveKiwi(malId, epNum, timestamp, (type as 'sub' | 'dub') || 'sub').catch((err) => {
      log('getAnikotoEmbedUrl: resolveKiwi threw unexpectedly', errInfo(err));
      return null;
    });
  }

  const [slug, epNumStr, , linkId, svId, encodedName] = parts;
  if (!slug || !linkId) {
    log('getAnikotoEmbedUrl: malformed regular sourceId', sourceId);
    return null;
  }
  const serverName = encodedName ? decodeURIComponent(encodedName) : 'anikoto';

  try {
    const svParam = svId ? { sv: svId } : {};
    const epReferer = `${BASE}/watch/${slug}/ep-${epNumStr}`;
    const res = await ajax.get('/ajax/server', {
      params: { get: linkId, ...svParam },
      headers: { Referer: epReferer },
    });
    const embedUrl: string | undefined = res.data?.result?.url;
    if (!embedUrl) {
      log('getAnikotoEmbedUrl: /ajax/server?get= returned no url', { serverName, linkId, svId, response: res.data });
      return null;
    }

    // anikoto's reference implementation tries the VidStream save_data.php
    // path FIRST for any server named like Vidstream/VidPlay/Vid-*, falling
    // back to the standard megacloud/megaplay chain if that doesn't pan out.
    const lower = serverName.toLowerCase();
    const isVidstreamLike = lower.includes('vidstream') || lower.includes('vidplay') || lower.includes('vid-');

    let result: AnikotoStream | null = null;
    if (isVidstreamLike) {
      result = await resolveVidstream(embedUrl, epReferer).catch((err) => {
        log('getAnikotoEmbedUrl: resolveVidstream threw unexpectedly', errInfo(err));
        return null;
      });
      if (result) result.serverName = serverName;
      else log('getAnikotoEmbedUrl: vidstream path failed, falling back to standard chain', { serverName, embedUrl });
    }
    if (!result) {
      result = await resolveAnikotoEmbed(embedUrl, serverName);
    }
    if (!result) log('getAnikotoEmbedUrl: all extraction paths failed', { serverName, embedUrl });
    return result;
  } catch (err) {
    log('getAnikotoEmbedUrl: /ajax/server?get= threw', { serverName, linkId, svId, ...errInfo(err) });
    return null;
  }
}
