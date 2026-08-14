import axios from '../utils/http';
import { anilistClient, UA } from './fetch';
import { cacheGet, cacheSet } from './cache';
import { findAnimeHeavenId } from '../scrapers/animeheaven';
import { findAnikotoSlug } from '../scrapers/anikoto';

export interface SiteIds {
  anilistId: number | null;
  malId: number | null;
  title: string;
  siteIds: {
    zoro?: string;
    gogoanime?: string;
    animeheaven?: string;
    anidao?: string;
    anikoto?: string;
  };
}

async function enrichAnimeHeaven(result: SiteIds): Promise<SiteIds> {
  if (!result.siteIds.animeheaven && result.title !== 'Unknown') {
    const id = await findAnimeHeavenId(result.title).catch(() => null);
    if (id) result.siteIds.animeheaven = id;
  }
  return result;
}

async function enrichAnikoto(result: SiteIds): Promise<SiteIds> {
  if (!result.siteIds.anikoto && result.title !== 'Unknown') {
    const slug = await findAnikotoSlug(result.title).catch(() => null);
    if (slug) result.siteIds.anikoto = slug;
  }
  return result;
}

// ── MAL (Jikan) — primary search + resolution path ─────────────────────────
// Jikan (https://jikan.moe) is a free, unofficial MAL API wrapper — no key
// or OAuth needed, unlike MAL's own API. Used as the primary path since the
// site is MAL-ID-first; AniList (below) is only a fallback for callers that
// explicitly pass ?anilistId=.
const JIKAN_BASE = 'https://api.jikan.moe/v4';

export async function searchMal(query: string): Promise<{
  malId: number; anilistId: number | null; title: string; coverImage: string; episodes: number | null; status: string; format: string;
}[]> {
  const cacheKey = `malsearch:${query.toLowerCase().trim()}`;
  const cached = cacheGet<any[]>(cacheKey);
  if (cached) return cached;

  const res = await axios.get(`${JIKAN_BASE}/anime`, {
    params: { q: query, limit: 10, sfw: false },
    timeout: 10000,
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  });
  const list: any[] = res.data?.data ?? [];

  const results = list.map((a: any) => ({
    malId: a.mal_id,
    anilistId: null,
    title: a.title_english || a.title,
    coverImage: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || '',
    episodes: a.episodes ?? null,
    status: a.status,
    format: a.type,
  }));

  cacheSet(cacheKey, results, 'episodes');
  return results;
}

async function getMalTitle(malId: number): Promise<string> {
  const cacheKey = `maltitle:${malId}`;
  const cached = cacheGet<string>(cacheKey);
  if (cached) return cached;

  const res = await axios.get(`${JIKAN_BASE}/anime/${malId}`, {
    timeout: 10000,
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  });
  const data = res.data?.data;
  const title = data?.title_english || data?.title || 'Unknown';
  if (title !== 'Unknown') cacheSet(cacheKey, title);
  return title;
}

// MAL ID → metadata + site-specific IDs (primary path)
export async function getSiteIdsByMal(malId: number): Promise<SiteIds | null> {
  const cacheKey = `siteids:mal:${malId}`;
  const cached = cacheGet<SiteIds>(cacheKey);
  if (cached) {
    const wasMissingAnimeHeaven = !cached.siteIds.animeheaven;
    const wasMissingAnikoto = !cached.siteIds.anikoto;
    const enriched = await enrichAnikoto(await enrichAnimeHeaven(cached));
    if ((wasMissingAnimeHeaven && enriched.siteIds.animeheaven) || (wasMissingAnikoto && enriched.siteIds.anikoto)) {
      cacheSet(cacheKey, enriched);
    }
    return enriched;
  }

  const title = await getMalTitle(malId).catch(() => 'Unknown');
  if (title === 'Unknown') return null;

  // Best-effort AniList ID for callers that want it too — never let AniList
  // trouble (rate limits, edge blocks, downtime) break this MAL-based path.
  const anilistId = await malToAnilist(malId).catch(() => null);

  const result: SiteIds = { anilistId, malId, title, siteIds: {} };
  await enrichAnimeHeaven(result);
  await enrichAnikoto(result);

  cacheSet(cacheKey, result);
  return result;
}

// Unified resolver used by routes.ts: malId is the primary path (Jikan,
// no AniList dependency); anilistId is a fallback for callers that only
// have an AniList ID.
export async function resolveSiteIds(anilistId?: string | null, malId?: string | null): Promise<SiteIds | null> {
  if (malId) {
    const id = parseInt(malId);
    if (isNaN(id)) return null;
    return getSiteIdsByMal(id);
  }
  if (anilistId) {
    const id = parseInt(anilistId);
    if (isNaN(id)) return null;
    return getSiteIds(id);
  }
  return null;
}

// ── AniList — fallback path (only used when caller passes ?anilistId=) ────

export async function malToAnilist(malId: number): Promise<number | null> {
  const cacheKey = `mal2al:${malId}`;
  const cached = cacheGet<number>(cacheKey);
  if (cached) return cached;

  const query = `query ($malId: Int) {
    Media(idMal: $malId, type: ANIME) { id idMal title { romaji english } }
  }`;
  const res = await anilistClient.post('', { query, variables: { malId } });
  const id = res.data?.data?.Media?.id ?? null;
  if (id) cacheSet(cacheKey, id);
  return id;
}

// Fetch title from AniList for a given anilistId
async function getAnilistTitle(anilistId: number): Promise<{ title: string; malId: number | null }> {
  const query = `query ($id: Int) {
    Media(id: $id, type: ANIME) { idMal title { romaji english } }
  }`;
  const res = await anilistClient.post('', { query, variables: { id: anilistId } });
  const media = res.data?.data?.Media;
  return {
    title: media?.title?.english ?? media?.title?.romaji ?? 'Unknown',
    malId: media?.idMal ?? null,
  };
}

// AniList ID → metadata + site-specific IDs
export async function getSiteIds(anilistId: number): Promise<SiteIds | null> {
  const cacheKey = `siteids:${anilistId}`;
  const cached = cacheGet<SiteIds>(cacheKey);
  if (cached) {
    const wasMissingAnimeHeaven = !cached.siteIds.animeheaven;
    const wasMissingAnikoto = !cached.siteIds.anikoto;
    const enriched = await enrichAnikoto(await enrichAnimeHeaven(cached));
    if ((wasMissingAnimeHeaven && enriched.siteIds.animeheaven) || (wasMissingAnikoto && enriched.siteIds.anikoto)) {
      cacheSet(cacheKey, enriched);
    }
    return enriched;
  }

  // Build result shell using AniList (always reliable for title + malId)
  const alInfo = await getAnilistTitle(anilistId).catch(() => ({ title: 'Unknown', malId: null }));

  const result: SiteIds = {
    anilistId,
    malId: alInfo.malId,
    title: alInfo.title,
    siteIds: {},
  };

  // Try Anify for site mappings
  try {
    const res = await axios.get(`https://api.anify.tv/info/${anilistId}`, {
      params: { fields: 'mappings' },
      timeout: 8000,
      headers: { 'User-Agent': UA },
    });
    const mappings: any[] = res.data?.mappings ?? [];
    for (const m of mappings) {
      if (m.providerId === 'zoro')      result.siteIds.zoro = m.id;
      if (m.providerId === 'gogoanime') result.siteIds.gogoanime = m.id;
      
      if (m.providerId === 'mal' && !result.malId) result.malId = parseInt(m.id);
    }
  } catch {
    // Anify down or missing — fall through to direct scraper fallbacks below
  }

  await enrichAnimeHeaven(result);
  await enrichAnikoto(result);

  // If still no zoro ID, try a slug guess (title-anilistId format common on HiAnime clones)
  // This is a heuristic and may not always work
  if (!result.siteIds.zoro && result.title !== 'Unknown') {
    const slug = result.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    result.siteIds.zoro = `${slug}-${anilistId}`;
  }

  cacheSet(cacheKey, result);
  return result;
}

// Search AniList by title
export async function searchAnilist(query: string): Promise<{
  id: number; malId: number | null; title: string; coverImage: string; episodes: number | null; status: string; format: string;
}[]> {
  const cacheKey = `alsearch:${query.toLowerCase().trim()}`;
  const cached = cacheGet<any[]>(cacheKey);
  if (cached) return cached;

  const gql = `query ($search: String) {
    Page(page: 1, perPage: 10) {
      media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
        id idMal episodes
        title { romaji english }
        coverImage { large medium }
        status format
      }
    }
  }`;

  const res = await anilistClient.post('', { query: gql, variables: { search: query } });
  const list = res.data?.data?.Page?.media ?? [];

  const results = list.map((m: any) => ({
    id: m.id,
    malId: m.idMal ?? null,
    title: m.title?.english ?? m.title?.romaji,
    coverImage: m.coverImage?.large ?? m.coverImage?.medium ?? '',
    episodes: m.episodes ?? null,
    status: m.status,
    format: m.format,
  }));

  cacheSet(cacheKey, results, 'episodes');
  return results;
}
