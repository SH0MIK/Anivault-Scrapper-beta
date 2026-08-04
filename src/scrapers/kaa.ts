import { buildTitles, diceCoeff, expectedCount, getMedia, UA } from '../utils/providerCore';
import { cacheGet, cacheSet } from '../utils/cache';

const BASE = 'https://kaa.lt';
const HLS_BASE = 'https://hls.krussdomi.com/manifest';
const H = { 'User-Agent': UA, Accept: 'application/json' };

export interface EpItem {
  id: string;
  number: number;
  title: string;
  audio: 'sub' | 'dub';
}

export interface ProviderStream {
  url: string;
  type: 'hls';
  server: string;
  referer: string;
}

async function kaaSearch(query: string): Promise<any[]> {
  const res = await fetch(`${BASE}/api/fsearch`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 1, query }),
  });
  if (!res.ok) throw new Error(`kaa fsearch HTTP ${res.status}`);
  const data: any = await res.json();
  return Array.isArray(data?.result) ? data.result : [];
}

async function kaaShowInfo(showSlug: string): Promise<any> {
  const res = await fetch(`${BASE}/api/show/${showSlug}`, { headers: H });
  if (!res.ok) throw new Error(`kaa show HTTP ${res.status}: ${showSlug}`);
  return res.json();
}

async function kaaEpisodePage(showSlug: string, ep: number): Promise<any> {
  const res = await fetch(`${BASE}/api/show/${showSlug}/episodes?ep=${ep}&lang=ja-JP`, { headers: H });
  if (!res.ok) throw new Error(`kaa episodes HTTP ${res.status}`);
  return res.json();
}

async function kaaAllEpisodes(showSlug: string): Promise<any[]> {
  const first: any = await kaaEpisodePage(showSlug, 1);
  const pages: any[] = Array.isArray(first.pages) ? first.pages : [];
  const all: any[] = Array.isArray(first.result) ? [...first.result] : [];

  if (pages.length > 1) {
    const rest = await Promise.all(
      pages.slice(1).map(async (pg) => {
        const startEp = pg.eps?.[0];
        if (!startEp) return [];
        const d: any = await kaaEpisodePage(showSlug, startEp);
        return Array.isArray(d.result) ? d.result : [];
      }),
    );
    for (const batch of rest) all.push(...batch);
  }
  return all;
}

async function kaaEpisodeServers(showSlug: string, fullEpSlug: string): Promise<any> {
  const res = await fetch(`${BASE}/api/show/${showSlug}/episode/${fullEpSlug}`, { headers: H });
  if (!res.ok) throw new Error(`kaa episode servers HTTP ${res.status}`);
  return res.json();
}

function buildKaaQueries(titles: string[]): string[] {
  const queries = new Set<string>();
  for (const title of titles.slice(0, 4)) {
    if (/[\u3000-\u9fff\u4e00-\u9faf]/.test(title)) continue;
    const clean = title.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length < 3) continue;
    const words = clean.split(' ').filter(Boolean);
    if (words.length <= 3) {
      queries.add(clean);
    } else {
      queries.add(words.slice(0, 2).join(' '));
      queries.add(words.slice(0, 3).join(' '));
    }
  }
  return [...queries];
}

function scoreCandidate(candidate: any, titles: string[], seasonYear: number | null, anilistFormat: string | null): number {
  const titleEn = candidate.title_en || '';
  const titleJp = candidate.title || '';
  const kaaYear = Number(candidate.year);
  const kaaType = (candidate.type || '').toLowerCase();

  let base = 0;
  for (const t of titles.slice(0, 3)) {
    if (/[\u3000-\u9fff\u4e00-\u9faf]/.test(t)) continue;
    base = Math.max(base, diceCoeff(t, titleEn), diceCoeff(t, titleJp));
  }

  let yearMult = 1.0;
  if (seasonYear && kaaYear) {
    const diff = Math.abs(Number(seasonYear) - kaaYear);
    if (diff === 0) yearMult = 1.2;
    else if (diff === 1) yearMult = 0.8;
    else yearMult = 0.5;
  }

  let typeMult = 1.0;
  const af = (anilistFormat || '').toUpperCase();
  if (af === 'MOVIE' && kaaType !== 'movie') typeMult = 0.25;
  else if (af !== 'MOVIE' && kaaType === 'movie') typeMult = 0.25;
  else if ((af === 'OVA' || af === 'ONA' || af === 'SPECIAL') && kaaType === 'tv') typeMult = 0.5;
  else if (af === 'TV' && (kaaType === 'ova' || kaaType === 'special')) typeMult = 0.5;

  return Math.min(1, base * yearMult) * typeMult;
}

async function resolveSeries(anilistId: number | string) {
  const cacheKey = `kaa:series:${anilistId}`;
  const cached = cacheGet<any>(cacheKey);
  if (cached) return cached;

  const media = await getMedia(anilistId);
  const titles = buildTitles(media);
  const queries = buildKaaQueries(titles);
  const seasonYear = media.seasonYear;
  const format = media.format;

  if (!queries.length) throw new Error(`KAA: no usable search queries for AniList ${anilistId}`);

  const allCandidates = new Map<string, any>();
  await Promise.all(
    queries.map(async (q) => {
      try {
        const results = await kaaSearch(q);
        for (const r of results) if (!allCandidates.has(r.slug)) allCandidates.set(r.slug, r);
      } catch {
        // ignore
      }
    }),
  );

  if (!allCandidates.size) throw new Error(`KAA: no search results for AniList ${anilistId}`);

  const scored: { slug: string; title: string; locales: string[]; score: number }[] = [];
  for (const [, candidate] of allCandidates) {
    const score = scoreCandidate(candidate, titles, seasonYear, format);
    if (score >= 0.5) {
      scored.push({
        slug: candidate.slug,
        title: candidate.title_en || candidate.title,
        locales: Array.isArray(candidate.locales) ? candidate.locales : [],
        score,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) throw new Error(`KAA: no confident match for AniList ${anilistId}`);

  const best = scored[0];
  if (best.score < 0.6) {
    throw new Error(`KAA: low confidence match for AniList ${anilistId} — best "${best.slug}" score ${best.score.toFixed(3)}`);
  }

  const data = { slug: best.slug, title: best.title, locales: best.locales, score: best.score };
  cacheSet(cacheKey, data, 'mapping');
  return data;
}

async function buildEpMap(showSlug: string, showInfo: any): Promise<{ number: number; fullSlug: string; title?: string }[]> {
  if (showInfo?.type === 'movie') {
    const m = (showInfo.watch_uri || '').match(/\/(ep-(\d+)-([a-f0-9]+))$/i);
    if (m) return [{ number: 1, fullSlug: m[1] }];
    return [];
  }
  const episodes = await kaaAllEpisodes(showSlug);
  return episodes.map((e: any) => ({
    number: e.episode_number,
    fullSlug: `ep-${e.episode_number}-${e.slug}`,
    title: e.title,
  }));
}

export async function getKaaEpisodes(anilistId: number | string) {
  const media = await getMedia(anilistId);
  const series = await resolveSeries(anilistId);
  const showInfo = await kaaShowInfo(series.slug);

  const locales: string[] = Array.isArray(showInfo.locales) ? showInfo.locales : series.locales;
  const hasDub = locales.includes('en-US');

  const epMap = await buildEpMap(series.slug, showInfo);
  if (!epMap.length) throw new Error(`KAA: no episodes found for AniList ${anilistId} (slug: ${series.slug})`);

  const expected = expectedCount(media);
  const sub: EpItem[] = [];
  const dub: EpItem[] = [];
  for (const ep of epMap) {
    const num = ep.number;
    if (!Number.isFinite(num) || num < 1) continue;
    if (expected && num > expected) continue;
    sub.push({ id: `kaa:${anilistId}:sub:${num}`, number: num, title: ep.title ?? `Episode ${num}`, audio: 'sub' });
    if (hasDub) dub.push({ id: `kaa:${anilistId}:dub:${num}`, number: num, title: ep.title ?? `Episode ${num}`, audio: 'dub' });
  }

  return {
    meta: { slug: series.slug, title: series.title, source: 'kaa', matchScore: Number(series.score.toFixed(3)) },
    episodes: { sub, dub },
  };
}

export async function getKaaWatch(anilistId: number | string, audio: 'sub' | 'dub', epNum: number) {
  const series = await resolveSeries(anilistId);
  const showInfo = await kaaShowInfo(series.slug);

  const locales: string[] = Array.isArray(showInfo.locales) ? showInfo.locales : series.locales;
  if (audio === 'dub' && !locales.includes('en-US')) throw new Error(`KAA: no English dub for AniList ${anilistId}`);

  const epMap = await buildEpMap(series.slug, showInfo);
  const ep = epMap.find((e) => e.number === Number(epNum));
  if (!ep) throw new Error(`KAA: episode ${epNum} not found for AniList ${anilistId}`);

  const episodeData = await kaaEpisodeServers(series.slug, ep.fullSlug);
  const servers: any[] = Array.isArray(episodeData.servers) ? episodeData.servers : [];
  if (!servers.length) throw new Error(`KAA: no streams for episode ${epNum} (AniList ${anilistId})`);

  const streams: ProviderStream[] = [];
  for (const s of servers) {
    if (!s.src) continue;
    const m = s.src.match(/[?&]id=([^&]+)/);
    if (!m) continue;
    streams.push({
      url: `${HLS_BASE}/${m[1]}/master.m3u8`,
      type: 'hls',
      server: s.name || 'KAA',
      referer: 'https://krussdomi.com/',
    });
  }
  if (!streams.length) throw new Error(`KAA: could not resolve stream for episode ${epNum}`);
  return { streams };
}
