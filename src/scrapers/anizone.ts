import {
  buildTitles,
  decodeEntities,
  diceCoeff,
  expectedCount,
  fetchHtml,
  getMedia,
  getPrequelOffset,
  norm,
  selectSeries,
  SearchCandidate,
  ScrapedEpisode,
} from '../utils/providerCore';
import { cacheGet, cacheSet } from '../utils/cache';

const BASE = 'https://anizone.to';

export interface EpItem {
  id: string;
  number: number;
  title: string;
  audio: 'sub';
}

export interface AniZoneSubtitle {
  url: string;
  label: string;
  srclang: string;
  format: string;
  default?: boolean;
}

export interface ProviderStream {
  url: string;
  type: 'hls';
  server: string;
  referer: string;
  subtitles: AniZoneSubtitle[];
  storyboard: string | null;
  chapters: string | null;
}

function scoreCandidate(query: string, candidate: string, slug: string): number {
  const base = Math.max(diceCoeff(query, candidate), diceCoeff(query, slug.replace(/-/g, ' ')));
  const isMovieQuery = /\b(movie|film|the movie)\b/i.test(query);
  const isMovieMatch = /\b(movie|film)\b/i.test(candidate) || /movie|film/.test(slug);
  if (isMovieQuery && !isMovieMatch) return base * 0.4;
  const qLen = norm(query).length;
  const sLen = norm(slug.replace(/-/g, ' ')).length;
  return sLen > qLen * 1.6 + 4 ? base * 0.8 : base;
}

function buildSearchQueries(title: string): string[] {
  const queries = new Set<string>([title]);
  const words = title.trim().split(/\s+/);
  if (words.length > 4) queries.add(words.slice(0, 4).join(' '));
  if (words.length > 3) queries.add(words.slice(0, 3).join(' '));
  const stripped = title
    .replace(/\bseason\s*\d+\b/gi, '')
    .replace(/\bpart\s*\d+\b/gi, '')
    .replace(/\b\d+rd\b|\b\d+th\b|\b\d+st\b|\b\d+nd\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped && stripped !== title) queries.add(stripped);
  return [...queries].filter((q) => q.length >= 3);
}

async function findCandidates(titles: string[], searchFn: (q: string) => Promise<SearchCandidate[]>, n = 6) {
  const allCandidates = new Map<string, string>();
  const searchQueries = new Set<string>();
  for (const title of titles.slice(0, 4)) for (const q of buildSearchQueries(title)) searchQueries.add(q);
  await Promise.all(
    [...searchQueries].map(async (q) => {
      try {
        const results = await searchFn(q);
        for (const r of results) if (!allCandidates.has(r.slug)) allCandidates.set(r.slug, r.text);
      } catch {
        // ignore
      }
    }),
  );
  const scored: { slug: string; title: string; score: number }[] = [];
  for (const [slug, text] of allCandidates) {
    let best = 0;
    for (const title of titles.slice(0, 2)) best = Math.max(best, scoreCandidate(title, text, slug));
    if (best >= 0.5) scored.push({ slug, title: text, score: best });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, n);
}

function processJsonArg(raw: string): any {
  const PH = '\x01U\x01';
  let s = raw.replace(/\\\\u([0-9a-fA-F]{4})/g, `${PH}$1`);
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\x01U\x01([0-9a-fA-F]{4})/g, '\\u$1');
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function pickTitle(titles: Record<string, string>): string {
  return titles['1'] || titles['5'] || titles['8'] || Object.values(titles)[0] || '';
}

function extractSlug(ctx: string): string | null {
  const m = ctx.match(/href="(?:https:\/\/anizone\.to)?\/anime\/([a-z0-9-]+)"/);
  return m ? m[1] : null;
}

function extractJsonArg(xdata: string, key: string): string | null {
  const re = new RegExp(`${key}:\\s*JSON\\.parse\\('((?:[^'\\\\]|\\\\.)*)'\\)`);
  const m = xdata.match(re);
  return m ? m[1] : null;
}

async function search(query: string): Promise<SearchCandidate[]> {
  const html = await fetchHtml(`${BASE}/anime?search=${encodeURIComponent(query)}`);
  const results: SearchCandidate[] = [];
  const xdataRe = /x-data="(\{[^"]*anmTitles[^"]*\})"/g;
  let m;
  while ((m = xdataRe.exec(html)) !== null) {
    const ctxStart = Math.max(0, m.index - 300);
    const ctxEnd = Math.min(html.length, m.index + m[0].length + 800);
    const ctx = html.slice(ctxStart, ctxEnd);
    const slug = extractSlug(ctx);
    if (!slug) continue;
    const xdata = decodeEntities(m[1]);
    const raw = extractJsonArg(xdata, 'anmTitles');
    if (!raw) continue;
    const titles = processJsonArg(raw);
    const title = pickTitle(titles);
    if (title) results.push({ slug, text: title });
  }
  return results;
}

async function searchFn(query: string): Promise<SearchCandidate[]> {
  const r1 = await search(query);
  const compact = query.split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '');
  if (compact.length >= 4 && compact.toLowerCase() !== query.toLowerCase()) {
    try {
      const r2 = await search(compact);
      const seen = new Set(r1.map((r) => r.slug));
      r2.forEach((r) => {
        if (!seen.has(r.slug)) r1.push(r);
      });
    } catch {
      // ignore
    }
  }
  return r1;
}

async function scrapeSeries(slug: string): Promise<ScrapedEpisode[]> {
  const html = await fetchHtml(`${BASE}/anime/${slug}`);
  const episodes: ScrapedEpisode[] = [];
  const xdataRe = /x-data="(\{[^"]*epsTitles[^"]*\})"/g;
  let m;
  while ((m = xdataRe.exec(html)) !== null) {
    const ctxStart = Math.max(0, m.index - 400);
    const ctxEnd = Math.min(html.length, m.index + m[0].length + 800);
    const ctx = html.slice(ctxStart, ctxEnd);
    const numMatch = ctx.match(/href="(?:https:\/\/anizone\.to)?\/anime\/[a-z0-9-]+\/(\d+)"/);
    if (!numMatch) continue;
    const num = Number(numMatch[1]);
    if (!Number.isFinite(num) || num < 1) continue;
    const xdata = decodeEntities(m[1]);
    const raw = extractJsonArg(xdata, 'epsTitles');
    let title = `Episode ${num}`;
    if (raw) {
      const titles = processJsonArg(raw);
      title = pickTitle(titles) || title;
    }
    episodes.push({ number: num, title, hasSub: true, hasDub: false });
  }
  const seen = new Set<number>();
  return episodes.filter((e) => (seen.has(e.number) ? false : (seen.add(e.number), true))).sort((a, b) => a.number - b.number);
}

async function scrapeWatch(slug: string, episodeNum: number) {
  const html = await fetchHtml(`${BASE}/anime/${slug}/${episodeNum}`);

  const hlsMatch = html.match(/<media-player[^>]+src="([^"]+\.m3u8[^"]*)"/i);
  const hls = hlsMatch ? decodeEntities(hlsMatch[1]) : null;

  const subtitles: AniZoneSubtitle[] = [];
  const trackRe = /<track\b([^>]*)>/gi;
  let t;
  while ((t = trackRe.exec(html)) !== null) {
    const attrs = t[1];
    const kind = attrs.match(/kind="([^"]*)"/i)?.[1] ?? '';
    if (kind !== 'subtitles') continue;
    const src = attrs.match(/src=["']?([^\s"'>]+)["']?/i)?.[1] ?? '';
    const label = attrs.match(/label="([^"]*)"/i)?.[1] ?? '';
    const srclang = attrs.match(/srclang="([^"]*)"/i)?.[1] ?? '';
    const dataType = attrs.match(/data-type="([^"]*)"/i)?.[1] ?? 'vtt';
    const isDefault = /\bdefault\b/.test(attrs);
    if (src) subtitles.push({ url: decodeEntities(src), label, srclang, format: dataType, default: isDefault });
  }

  const storyboardMatch = html.match(/thumbnails="([^"]+\.vtt[^"]*)"/i);
  const storyboard = storyboardMatch ? decodeEntities(storyboardMatch[1]) : null;

  const chaptersMatch = html.match(/<track\b[^>]*kind="chapters"[^>]*src=["']?([^\s"'>]+)["']?/i);
  const chapters = chaptersMatch ? decodeEntities(chaptersMatch[1]) : null;

  return { hls, subtitles, storyboard, chapters };
}

async function resolveSeries(anilistId: number | string) {
  const cacheKey = `anizone:series:${anilistId}`;
  const cached = cacheGet<any>(cacheKey);
  if (cached) return cached;

  const media = await getMedia(anilistId);
  const titles = buildTitles(media);
  let candidates = await findCandidates(titles, searchFn);

  const seasonYear = media.seasonYear;
  if (seasonYear && candidates.some((c) => /\(\d{4}\)/.test(c.title))) {
    candidates = candidates
      .map((c) => {
        const m = c.title.match(/\((\d{4})\)/);
        if (m) {
          return parseInt(m[1]) === seasonYear ? { ...c, score: Math.min(1, c.score * 1.3) } : { ...c, score: c.score * 0.5 };
        }
        return { ...c, score: c.score * 0.65 };
      })
      .sort((a, b) => b.score - a.score);
  }

  const expected = expectedCount(media);
  const offset = await getPrequelOffset(anilistId).catch(() => 0);
  const selected = await selectSeries(candidates, scrapeSeries, expected, media.status, offset);
  if (!selected) throw new Error(`AniZone: no match found for AniList ${anilistId}`);
  const data = { slug: selected.slug, title: selected.title, mode: selected.mode, offset, score: selected.score };
  cacheSet(cacheKey, data, 'mapping');
  return data;
}

export async function getAnizoneEpisodes(anilistId: number | string) {
  const media = await getMedia(anilistId);
  const series = await resolveSeries(anilistId);
  const episodes = await scrapeSeries(series.slug);
  const expected = expectedCount(media);

  const sub: EpItem[] = [];
  for (const src of episodes) {
    const number = series.mode === 'offset' ? src.number - series.offset : src.number;
    if (number < 1) continue;
    if (expected && number > expected) continue;
    sub.push({ id: `anizone:${anilistId}:sub:${number}`, number, title: src.title, audio: 'sub' });
  }

  return {
    meta: {
      slug: series.slug,
      title: series.title,
      source: 'anizone',
      matchScore: Number(series.score.toFixed(3)),
      numbering: series.mode,
      episodeOffset: series.mode === 'offset' ? series.offset : 0,
      note: 'AniZone is sub-only.',
    },
    episodes: { sub, dub: [] as EpItem[] },
  };
}

export async function getAnizoneWatch(anilistId: number | string, audio: 'sub' | 'dub', epNum: number) {
  if (audio === 'dub') throw new Error('AniZone does not provide dubbed audio');
  const series = await resolveSeries(anilistId);
  const providerEp = series.mode === 'offset' ? epNum + series.offset : epNum;
  const watch = await scrapeWatch(series.slug, providerEp);
  if (!watch.hls) throw new Error(`AniZone: no HLS stream found for AniList ${anilistId} ep ${epNum}`);
  const stream: ProviderStream = {
    url: watch.hls,
    type: 'hls',
    server: 'AniZone',
    // AniZone's CDN, like most of these, blocks hotlinked segment requests
    // that don't carry its own Referer. Without this, every segment fetch
    // through /proxy/hls comes from a bare server-to-server request and
    // gets rejected identically each time — which looks like the stream
    // "timing out" client-side rather than an obvious error.
    referer: `${BASE}/`,
    subtitles: watch.subtitles,
    storyboard: watch.storyboard,
    chapters: watch.chapters,
  };
  return { providerEpisode: providerEp, streams: [stream] };
}
