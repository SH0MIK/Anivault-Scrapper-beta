// ─────────────────────────────────────────────────────────────────
// providerCore.ts
//
// Shared helpers for the "AniList-native" scrapers: reanime, anineko,
// 2dhive, anizone, kaa. Unlike senshi/anikoto/animeheaven/miruro (which
// resolve via pre-mapped site IDs from utils/mapper.ts), these sources
// don't have a reliable external ID mapping — so instead they search the
// target site directly by title and pick the best-scoring match, exactly
// like they do upstream. This file ports that matching logic.
// ─────────────────────────────────────────────────────────────────

import { cacheGet, cacheSet } from './cache';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── HTML fetch helper ──────────────────────────────────────────────

export async function fetchHtml(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...headers,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

// ── String helpers ─────────────────────────────────────────────────

export function decodeEntities(s = ''): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export function stripTags(html = ''): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

export function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`${name}=["']([^"']*)["']`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

export function norm(s = ''): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function diceCoeff(a: string, b: string): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < na.length - 1; i++) {
    const bg = na.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < nb.length - 1; i++) {
    const bg = nb.slice(i, i + 2);
    const count = bigrams.get(bg) ?? 0;
    if (count > 0) {
      hits++;
      bigrams.set(bg, count - 1);
    }
  }
  return (2 * hits) / (na.length + nb.length - 2);
}

export function titleScore(query: string, candidate: string, slug: string): number {
  const base = Math.max(diceCoeff(query, candidate), diceCoeff(query, slug.replace(/-/g, ' ')));
  const queryFirstNum = norm(query).match(/\d+/)?.[0] ?? '';
  const slugFirstNum = slug.match(/\d+/)?.[0] ?? '';
  if (queryFirstNum && slugFirstNum && queryFirstNum !== slugFirstNum) return base * 0.65;
  if (queryFirstNum && !slugFirstNum) return base * 0.65;
  if (!queryFirstNum && slugFirstNum) {
    const n = parseInt(slugFirstNum);
    if (n > 1 && n < 1900) return base * (1 - 0.06 * (n - 1));
  }
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

export interface SearchCandidate {
  slug: string;
  text: string;
}

export interface ScoredCandidate {
  slug: string;
  title: string;
  score: number;
}

export async function findTopSlugs(
  titles: string[],
  searchFn: (q: string) => Promise<SearchCandidate[]>,
  n = 6,
): Promise<ScoredCandidate[]> {
  const allCandidates = new Map<string, string>();
  const searchQueries = new Set<string>();
  for (const title of titles.slice(0, 4)) {
    for (const q of buildSearchQueries(title)) searchQueries.add(q);
  }
  await Promise.all(
    [...searchQueries].map(async (q) => {
      try {
        const results = await searchFn(q);
        for (const r of results) if (!allCandidates.has(r.slug)) allCandidates.set(r.slug, r.text);
      } catch {
        // ignore individual query failures
      }
    }),
  );
  const scored: ScoredCandidate[] = [];
  for (const [slug, text] of allCandidates) {
    let best = 0;
    for (const title of titles.slice(0, 2)) best = Math.max(best, titleScore(title, text, slug));
    if (best >= 0.5) scored.push({ slug, title: text, score: best });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, n);
}

// ── AniList media lookup (title/episodes/synonyms/status) ──────────

export interface AniListMedia {
  id: number;
  idMal: number | null;
  title: { english: string | null; romaji: string | null; native: string | null };
  status: string;
  format: string | null;
  episodes: number | null;
  seasonYear: number | null;
  synonyms: string[];
}

const mediaCache = new Map<number, AniListMedia>();
const mediaInflight = new Map<number, Promise<AniListMedia>>();

async function fetchFromAniList(id: number): Promise<any> {
  const query = `query($id:Int){Media(id:$id,type:ANIME){id idMal title{english romaji native} status format episodes seasonYear synonyms}}`;
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ query, variables: { id } }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const json: any = await res.json();
  return json.data?.Media ?? null;
}

const AL_STATUS_MAP: Record<string, string> = {
  RELEASING: 'RELEASING',
  FINISHED: 'FINISHED',
  NOT_YET_RELEASED: 'NOT_YET_RELEASED',
  CANCELLED: 'FINISHED',
  HIATUS: 'HIATUS',
};

export async function getMedia(anilistId: number | string): Promise<AniListMedia> {
  const id = Number(anilistId);
  if (mediaCache.has(id)) return mediaCache.get(id)!;
  if (mediaInflight.has(id)) return mediaInflight.get(id)!;

  const promise = (async () => {
    const al = await fetchFromAniList(id);
    if (!al) throw new Error(`No AniList data found for ID ${id}`);
    const media: AniListMedia = {
      id,
      idMal: al.idMal ?? null,
      title: {
        english: al.title?.english ?? null,
        romaji: al.title?.romaji ?? null,
        native: al.title?.native ?? null,
      },
      status: AL_STATUS_MAP[al.status] ?? 'RELEASING',
      format: al.format ?? null,
      episodes: al.episodes ?? null,
      seasonYear: al.seasonYear ?? null,
      synonyms: Array.isArray(al.synonyms) ? al.synonyms : [],
    };
    mediaCache.set(id, media);
    mediaInflight.delete(id);
    return media;
  })().catch((e) => {
    mediaInflight.delete(id);
    throw e;
  });

  mediaInflight.set(id, promise);
  return promise;
}

export function buildTitles(media: AniListMedia | null | undefined): string[] {
  return [media?.title?.english, media?.title?.romaji, media?.title?.native, ...(media?.synonyms ?? [])].filter(
    Boolean,
  ) as string[];
}

export function expectedCount(media: AniListMedia | null | undefined): number | null {
  return media?.episodes && media.episodes > 0 ? media.episodes : null;
}

// ── Prequel offset (for sites that number episodes continuously across seasons) ──

const RELATION_FRAGMENT = `edges{relationType(version:2) node{id type episodes relations{edges{relationType(version:2) node{id type episodes relations{edges{relationType(version:2) node{id type episodes}}}}}}}}`;

interface RelationNode {
  relationType: string;
  node: { id: number; type: string; episodes: number | null; relations?: { edges: RelationNode[] } };
}

function computePrequelOffset(relations: { edges: RelationNode[] } | null | undefined, depth = 0): number {
  if (!relations || depth > 5) return 0;
  const prequelEdge = relations.edges?.find(
    (e) => e.relationType === 'PREQUEL' && e.node.type === 'ANIME' && (e.node.episodes ?? 0) >= 5,
  );
  if (!prequelEdge) return 0;
  return (prequelEdge.node.episodes ?? 0) + computePrequelOffset(prequelEdge.node.relations, depth + 1);
}

export async function getPrequelOffset(anilistId: number | string): Promise<number> {
  const key = `np:offset:${anilistId}`;
  const cached = cacheGet<number>(key);
  if (cached !== null) return cached;

  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      query: `query($id:Int){Media(id:$id,type:ANIME){relations{${RELATION_FRAGMENT}}}}`,
      variables: { id: Number(anilistId) },
    }),
  });
  const json: any = await res.json();
  const offset = computePrequelOffset(json?.data?.Media?.relations);
  cacheSet(key, offset, 'mapping');
  return offset;
}

// ── Series selection (pick the best-matching slug by episode-count fit) ──

export interface ScrapedEpisode {
  number: number;
  title: string;
  hasSub: boolean;
  hasDub: boolean;
  [key: string]: any;
}

export interface SelectedSeries extends ScoredCandidate {
  episodes: ScrapedEpisode[];
  max: number;
  mode: 'local' | 'offset';
}

export async function selectSeries(
  candidates: ScoredCandidate[],
  scrapeSeries: (slug: string) => Promise<ScrapedEpisode[]>,
  expected: number | null,
  status: string | undefined,
  offset: number,
  minScore = 0.65,
): Promise<SelectedSeries | null> {
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const episodes = await scrapeSeries(candidate.slug).catch(() => [] as ScrapedEpisode[]);
      const max = Math.max(0, ...episodes.map((e) => e.number));
      const localHits = expected ? episodes.filter((e) => e.number >= 1 && e.number <= expected).length : episodes.length;
      const offsetHits =
        expected && offset ? episodes.filter((e) => e.number > offset && e.number <= offset + expected).length : 0;
      const mode: 'local' | 'offset' = offsetHits > localHits ? 'offset' : 'local';
      const hits = Math.max(localHits, offsetHits);
      let countScore = 1;
      if (expected && expected >= 6) {
        const needed = status === 'FINISHED' ? Math.ceil(expected * 0.9) : Math.max(1, expected - 3);
        countScore = hits >= needed ? 1 : hits / needed;
      }
      return { ...candidate, episodes, max, mode, score: candidate.score * 0.7 + countScore * 0.3 };
    }),
  );
  const viable = results.filter((r) => r.episodes.length && r.score >= minScore).sort((a, b) => b.score - a.score);
  return viable[0] ?? null;
}
