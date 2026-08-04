import * as cheerio from 'cheerio';
import { makeClient, makeAjaxClient } from '../utils/fetch';
import { cacheGet, cacheSet } from '../utils/cache';

const BASE = 'https://animepahe.pw';
const http = makeClient(BASE, BASE + '/');
const ajax = makeAjaxClient(BASE, BASE + '/');

export interface PaheEpisode {
  num: number;
  session: string;
  snapshot: string;
  duration: string;
  created: string;
}

// Search AnimePahe
export async function searchAnimePahe(query: string): Promise<{ id: string; title: string; session: string }[]> {
  const cacheKey = `pahe:search:${query}`;
  const cached = cacheGet<any[]>(cacheKey);
  if (cached) return cached;

  const res = await ajax.get('/api', { params: { m: 'search', q: query } });
  const data = res.data?.data ?? [];

  const results = data.map((a: any) => ({
    id: String(a.id),
    title: a.title,
    session: a.session,
  }));

  cacheSet(cacheKey, results, 'episodes');
  return results;
}

// Get episode list for a session
export async function getPaheEpisodes(session: string, page = 1): Promise<PaheEpisode[]> {
  const cacheKey = `pahe:eps:${session}:${page}`;
  const cached = cacheGet<PaheEpisode[]>(cacheKey);
  if (cached) return cached;

  const res = await ajax.get('/api', {
    params: { m: 'release', id: session, sort: 'episode_asc', page },
  });

  const episodes: PaheEpisode[] = (res.data?.data ?? []).map((e: any) => ({
    num: e.episode,
    session: e.session,
    snapshot: e.snapshot ?? '',
    duration: e.duration ?? '',
    created: e.created_at ?? '',
  }));

  if (episodes.length > 0) cacheSet(cacheKey, episodes, 'episodes');
  return episodes;
}

// Get embed links for a pahe episode (returns kwik embed URLs)
export async function getPaheEmbeds(animeSession: string, episodeSession: string): Promise<{ quality: string; url: string; audio: string }[]> {
  const res = await ajax.get(`/play/${animeSession}/${episodeSession}`, {
    headers: { Accept: 'text/html' },
  });

  const $ = cheerio.load(res.data);
  const embeds: { quality: string; url: string; audio: string }[] = [];

  // AnimePahe serves buttons that link to kwik.si
  $('button[data-src], [data-kwa]').each((_, el) => {
    const url = $(el).attr('data-src') ?? $(el).attr('data-kwa') ?? '';
    const quality = $(el).text().trim() || $(el).attr('data-resolution') || 'HD';
    const audio = $(el).attr('data-audio') ?? 'jpn';
    if (url.includes('kwik')) embeds.push({ quality, url, audio });
  });

  return embeds;
}
