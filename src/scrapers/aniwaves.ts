import * as cheerio from 'cheerio';
import { makeClient, makeAjaxClient } from '../utils/fetch';
import { cacheGet, cacheSet } from '../utils/cache';

const BASE = 'https://aniwaves.ru';
const http = makeClient(BASE, BASE + '/');
const ajax = makeAjaxClient(BASE, BASE + '/');

export interface WaveEpisode {
  num: number;
  id: string;
  title: string;
}

export interface WaveServer {
  name: string;
  sourceId: string;
  type: 'sub' | 'dub' | 'raw';
}

function titleSlug(input: string): string {
  return input.replace(/-\d+$/, '').toLowerCase();
}

function serverType(raw: string): 'sub' | 'dub' | 'raw' {
  const value = raw.toLowerCase();
  if (value.includes('dub')) return 'dub';
  if (value.includes('raw')) return 'raw';
  return 'sub';
}

async function resolveWaveWatchId(animeId: string): Promise<string | null> {
  const direct = animeId.match(/-(\d{3,})$/)?.[1];
  if (direct && direct !== animeId.split('-').pop()) return direct;

  const query = titleSlug(animeId);
  const res = await http.get('/filter', { params: { keyword: query } });
  const $ = cheerio.load(res.data);
  const wanted = query.replace(/-/g, ' ');

  let fallback = '';
  let exact = '';
  $('a[href^="/watch/"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const id = href.match(/-(\d+)$/)?.[1] ?? '';
    const title = $(el).find('.name, .d-title').first().text().trim().toLowerCase()
      || $(el).attr('data-jp')?.toLowerCase()
      || '';
    if (id && !fallback) fallback = id;
    if (id && (title === wanted || href.includes(`/watch/${query}-`))) exact = id;
  });

  return exact || fallback || null;
}

export async function searchAniWaves(query: string): Promise<{ title: string; id: string; url: string }[]> {
  const res = await http.get('/filter', { params: { keyword: query } });
  const $ = cheerio.load(res.data);
  const results: { title: string; id: string; url: string }[] = [];

  $('a[href^="/watch/"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const id = href.split('/').filter(Boolean).pop()?.split('?')[0] ?? '';
    const title = $(el).find('.name, .d-title').first().text().trim() || $(el).text().trim();
    if (title && id && !results.some((r) => r.id === id)) results.push({ title, id, url: BASE + href });
  });

  return results;
}

export async function getWaveEpisodes(animeId: string): Promise<WaveEpisode[]> {
  const cacheKey = `wave:eps:${animeId}`;
  const cached = cacheGet<WaveEpisode[]>(cacheKey);
  if (cached) return cached;

  const watchId = await resolveWaveWatchId(animeId);
  if (!watchId) return [];

  const res = await ajax.get(`/ajax/episode/list/${watchId}`, {
    headers: { Referer: `${BASE}/watch/${animeId}` },
  });
  const html = res.data?.result ?? res.data?.html ?? (typeof res.data === 'string' ? res.data : '');
  const $ = cheerio.load(html);

  const episodes: WaveEpisode[] = [];
  $('a[data-ids][data-num]').each((_, el) => {
    const id = $(el).attr('data-ids') ?? '';
    const num = Number($(el).attr('data-num') ?? 0);
    const title = $(el).attr('title') ?? ($(el).text().replace(/\s+/g, ' ').trim() || `Episode ${num}`);
    if (id && num > 0) episodes.push({ num, id, title });
  });

  if (episodes.length > 0) cacheSet(cacheKey, episodes, 'episodes');
  return episodes;
}

export async function getWaveServers(episodeId: string): Promise<WaveServer[]> {
  const res = await ajax.get(`/ajax/server/list?servers=${episodeId}`);
  const html = res.data?.result ?? res.data?.html ?? '';
  const $ = cheerio.load(html);
  const servers: WaveServer[] = [];

  $('[data-link-id]').each((_, el) => {
    const sourceId = $(el).attr('data-link-id') ?? '';
    const group = $(el).closest('[data-type]').attr('data-type') ?? '';
    const name = $(el).text().replace(/\s+/g, ' ').trim() || `Server ${$(el).attr('data-sv-id') ?? ''}`.trim();
    if (sourceId) servers.push({ name, sourceId, type: serverType(group || name) });
  });

  return servers;
}

export async function getWaveEmbedUrl(sourceId: string): Promise<{ embedUrl: string; serverName: string } | null> {
  if (/^https?:\/\//i.test(sourceId)) return { embedUrl: sourceId, serverName: new URL(sourceId).hostname };

  try {
    const res = await ajax.get('/ajax/sources', {
      params: { id: sourceId, asi: 0, autoPlay: 0 },
    });
    const data = res.data?.result ?? res.data;
    if (data?.url) return { embedUrl: data.url, serverName: String(data.server ?? 'server') };
    if (data?.link) return { embedUrl: data.link, serverName: data.server ?? 'server' };
    return null;
  } catch {
    return null;
  }
}
