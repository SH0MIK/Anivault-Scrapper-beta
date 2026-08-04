import * as cheerio from 'cheerio';
import { makeClient, makeAjaxClient } from '../utils/fetch';
import { cacheGet, cacheSet } from '../utils/cache';

const BASE = 'https://anidao.to';
const http = makeClient(BASE, BASE + '/');
const ajax = makeAjaxClient(BASE, BASE + '/');

export interface DaoEpisode {
  num: number;
  id: string;
  title: string;
}

export interface DaoServer {
  name: string;
  sourceId: string;
  type: 'sub' | 'dub' | 'raw';
}

function normalizeAnimeId(animeId: string): string {
  return animeId.replace(/-\d+$/, '');
}

function serverType(raw: string): 'sub' | 'dub' | 'raw' {
  const value = raw.toLowerCase();
  if (value.includes('dub')) return 'dub';
  if (value.includes('raw')) return 'raw';
  return 'sub';
}

export async function searchAniDao(query: string): Promise<{ title: string; id: string; url: string }[]> {
  const res = await http.get('/search.html', { params: { keyword: query } });
  const $ = cheerio.load(res.data);
  const results: { title: string; id: string; url: string }[] = [];

  $('a[href^="/anime/"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const title = $(el).find('[data-an-name-en], .name, h3').first().text().trim() || $(el).text().trim();
    const id = href.split('/').filter(Boolean).pop()?.split('?')[0] ?? '';
    if (title && id && !results.some((r) => r.id === id)) results.push({ title, id, url: BASE + href });
  });

  return results;
}

export async function getDaoEpisodes(animeId: string): Promise<DaoEpisode[]> {
  const slug = normalizeAnimeId(animeId);
  const cacheKey = `dao:eps:${slug}`;
  const cached = cacheGet<DaoEpisode[]>(cacheKey);
  if (cached) return cached;

  const res = await http.get(`/anime/${slug}`);
  const $ = cheerio.load(res.data);
  const episodes: DaoEpisode[] = [];

  $('a[href^="/watch-online/"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const match = href.match(/episode-(\d+(?:\.\d+)?)/i);
    const num = match ? Number(match[1]) : 0;
    const title = $(el).find('.title, .name').first().text().trim() || `Episode ${num}`;
    if (num > 0 && !episodes.some((ep) => ep.num === num)) {
      episodes.push({ num, id: href, title });
    }
  });

  episodes.sort((a, b) => a.num - b.num);
  if (episodes.length > 0) cacheSet(cacheKey, episodes, 'episodes');
  return episodes;
}

export async function getDaoServers(episodeId: string): Promise<DaoServer[]> {
  if (episodeId.startsWith('/watch-online/')) {
    const res = await http.get(episodeId);
    const $ = cheerio.load(res.data);
    const servers: DaoServer[] = [];

    $('[data-an-video]').each((_, el) => {
      const sourceId = $(el).attr('data-an-video') ?? '';
      const group = $(el).closest('[data-an-panel]').attr('data-an-panel') ?? '';
      const label = $(el).text().replace(/\s+/g, ' ').trim();
      const name = label || $(el).attr('data-an-server-btn') || 'Server';
      if (sourceId) servers.push({ name, sourceId, type: serverType(group || name) });
    });

    return servers;
  }

  const res = await ajax.get('/ajax/v2/episode/servers', { params: { episodeId } });
  const html = res.data?.html ?? '';
  const $ = cheerio.load(html);
  const servers: DaoServer[] = [];

  $('[data-type="sub"] li[data-id], .servers-sub li[data-id]').each((_, el) => {
    const sourceId = $(el).attr('data-id') ?? '';
    const name = $(el).text().trim() || 'Server';
    if (sourceId) servers.push({ name, sourceId, type: 'sub' });
  });

  $('[data-type="dub"] li[data-id], .servers-dub li[data-id]').each((_, el) => {
    const sourceId = $(el).attr('data-id') ?? '';
    const name = $(el).text().trim() || 'Server';
    if (sourceId) servers.push({ name, sourceId, type: 'dub' });
  });

  return servers;
}

export async function getDaoEmbedUrl(sourceId: string): Promise<{ embedUrl: string; serverName: string } | null> {
  if (/^https?:\/\//i.test(sourceId)) return { embedUrl: sourceId, serverName: new URL(sourceId).hostname };

  try {
    const res = await ajax.get('/ajax/v2/episode/sources', { params: { id: sourceId } });
    const data = res.data;
    if (data?.link) return { embedUrl: data.link, serverName: data.server ?? 'server' };
    if (data?.url) return { embedUrl: data.url, serverName: 'server' };
    return null;
  } catch {
    return null;
  }
}
