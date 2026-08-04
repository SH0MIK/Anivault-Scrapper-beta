import {
  attr,
  buildTitles,
  decodeEntities,
  expectedCount,
  fetchHtml,
  findTopSlugs,
  getMedia,
  getPrequelOffset,
  selectSeries,
  stripTags,
  SearchCandidate,
  ScrapedEpisode,
} from '../utils/providerCore';
import { cacheGet, cacheSet } from '../utils/cache';

const BASE = 'https://anineko.to';

export interface ProviderStream {
  url: string;
  type: 'hls' | 'embed';
  server: string;
  referer?: string;
  isActive?: boolean;
}

export interface EpItem {
  id: string;
  number: number;
  title: string;
  audio: 'sub' | 'dub';
}

async function search(query: string): Promise<SearchCandidate[]> {
  const html = await fetchHtml(`${BASE}/browser?keyword=${encodeURIComponent(query)}`);
  const results: SearchCandidate[] = [];
  for (const m of html.matchAll(/<a\b[^>]*class=["'][^"']*nv-anime-thumb[^"']*["'][^>]*>[\s\S]*?<\/a>/gi)) {
    const tag = m[0].match(/<a\b[^>]*>/i)?.[0] ?? '';
    const href = attr(tag, 'href');
    const slug = href.match(/\/watch\/([^/?#]+)/)?.[1];
    if (!slug) continue;
    const titleMatch = m[0].match(
      /<(?:h3|[^>]+class=["'][^"']*nv-anime-title[^"']*["'][^>]*)>([\s\S]*?)<\/(?:h3|[^>]+)>/i,
    );
    results.push({ slug, text: titleMatch ? stripTags(titleMatch[1]) : slug.replace(/-/g, ' ') });
  }
  return results;
}

async function scrapeSeries(slug: string): Promise<ScrapedEpisode[]> {
  const html = await fetchHtml(`${BASE}/watch/${slug}`);
  const episodes: ScrapedEpisode[] = [];
  for (const m of html.matchAll(/<article\b[^>]*class=["'][^"']*nv-info-episode-item[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi)) {
    const block = m[1];
    const link = block.match(/<a\b[^>]*class=["'][^"']*nv-info-episode-main[^"']*["'][^>]*>/i)?.[0] ?? '';
    const href = attr(link, 'href');
    const num = Number(href.match(/\/ep-(\d+)/)?.[1]);
    if (!Number.isFinite(num)) continue;
    const title = stripTags(
      block.match(/<a\b[^>]*class=["'][^"']*nv-info-episode-main[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '',
    );
    const badges = [...block.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map((b) => stripTags(b[1]).toLowerCase());
    episodes.push({
      number: num,
      title: title || `Episode ${num}`,
      hasSub: badges.includes('sub'),
      hasDub: badges.includes('dub'),
    });
  }
  episodes.sort((a, b) => a.number - b.number);
  const seen = new Set<number>();
  return episodes.filter((e) => (seen.has(e.number) ? false : (seen.add(e.number), true)));
}

async function extractHls(embedUrl: string): Promise<string | null> {
  const html = await fetchHtml(embedUrl, { Referer: `${BASE}/` }).catch(() => '');
  const patterns = [
    /const\s+src\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\/master\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) return decodeEntities(m[1]);
  }
  return null;
}

async function scrapeEpisodeWatch(seriesSlug: string, epSlug: string, audio: 'sub' | 'dub'): Promise<ProviderStream[]> {
  const html = await fetchHtml(`${BASE}/watch/${seriesSlug}/${epSlug}`, { Referer: `${BASE}/watch/${seriesSlug}` });
  const byAudio: Record<'sub' | 'dub', string[]> = { sub: [], dub: [] };
  for (const panel of html.matchAll(
    /<div\b[^>]*class=["'][^"']*nv-server-grid[^"']*["'][^>]*data-id=["']([^"']+)["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*nv-server-grid|$)/gi,
  )) {
    const rawAudio = panel[1].toLowerCase();
    const panelAudio: 'sub' | 'dub' = rawAudio.includes('dub') ? 'dub' : 'sub';
    for (const btn of panel[2].matchAll(/data-video=["']([^"']+)["']/gi)) byAudio[panelAudio].push(decodeEntities(btn[1]));
  }
  const embeds = byAudio[audio] ?? [];
  const streams = await Promise.all(
    embeds.map(async (embed, i) => {
      const hls = await extractHls(embed);
      return {
        url: hls ?? embed,
        type: (hls ? 'hls' : 'embed') as 'hls' | 'embed',
        server: 'AniNeko',
        referer: `${new URL(embed).origin}/`,
        isActive: i === 0,
      };
    }),
  );
  return streams;
}

async function resolveSeries(anilistId: number | string) {
  const cacheKey = `anineko:series:${anilistId}`;
  const cached = cacheGet<any>(cacheKey);
  if (cached) return cached;

  const media = await getMedia(anilistId);
  const titles = buildTitles(media);
  const candidates = await findTopSlugs(titles, search);
  const expected = expectedCount(media);
  const offset = await getPrequelOffset(anilistId).catch(() => 0);
  const selected = await selectSeries(candidates, scrapeSeries, expected, media.status, offset);
  if (!selected) throw new Error(`AniNeko: no match found for AniList ${anilistId}`);
  const data = { slug: selected.slug, title: selected.title, mode: selected.mode, offset, score: selected.score };
  cacheSet(cacheKey, data, 'mapping');
  return data;
}

export async function getAninekoEpisodes(anilistId: number | string) {
  const media = await getMedia(anilistId);
  const series = await resolveSeries(anilistId);
  const episodes = await scrapeSeries(series.slug);
  const expected = expectedCount(media);

  const sub: EpItem[] = [];
  const dub: EpItem[] = [];
  for (const src of episodes) {
    const number = series.mode === 'offset' ? src.number - series.offset : src.number;
    if (number < 1) continue;
    if (expected && number > expected) continue;
    if (src.hasSub) sub.push({ id: `anineko:${anilistId}:sub:${number}`, number, title: src.title, audio: 'sub' });
    if (src.hasDub) dub.push({ id: `anineko:${anilistId}:dub:${number}`, number, title: src.title, audio: 'dub' });
  }

  return {
    meta: {
      slug: series.slug,
      title: series.title,
      source: 'anineko',
      matchScore: Number(series.score.toFixed(3)),
      numbering: series.mode,
      episodeOffset: series.mode === 'offset' ? series.offset : 0,
    },
    episodes: { sub, dub },
  };
}

export async function getAninekoWatch(anilistId: number | string, audio: 'sub' | 'dub', epNum: number) {
  const series = await resolveSeries(anilistId);
  const providerEp = series.mode === 'offset' ? epNum + series.offset : epNum;
  const streams = await scrapeEpisodeWatch(series.slug, `ep-${providerEp}`, audio);
  if (!streams.length) throw new Error(`AniNeko: no ${audio} streams for AniList ${anilistId} ep ${epNum}`);
  return { providerEpisode: providerEp, streams };
}
