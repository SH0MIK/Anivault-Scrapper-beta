import * as cheerio from 'cheerio';
import { makeClient, makeAjaxClient } from '../utils/fetch';
import { cacheGet, cacheSet } from '../utils/cache';

const BASE = 'https://senshi.live';
// Senshi is behind Cloudflare, so it needs FlareSolverr (useFlareSolverr = true)
const http = makeClient(BASE, BASE + '/', true);
const ajax = makeAjaxClient(BASE, BASE + '/', true);

export interface SenshiEpisode {
  num: number;
  id: string;
  title: string;
}

export interface SenshiServer {
  name: string;
  serverId: string;
  sourceId: string;
  type: 'sub' | 'dub' | 'raw';
}

export interface EmbedResult {
  embedUrl: string;
  serverName: string;
  type: string;
  referer?: string;
}

// Legacy search kept for compatibility with callers that import it directly.
export async function searchSenshi(query: string): Promise<{ title: string; id: string; url: string }[]> {
  const res = await http.get('/search', { params: { keyword: query } });
  const $ = cheerio.load(res.data);
  const results: { title: string; id: string; url: string }[] = [];

  $('.flw-item .film-name a, [class*="film-detail"] h3 a').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const title = $(el).text().trim();
    const id = href.split('/').filter(Boolean).pop()?.split('?')[0] ?? '';
    if (title && id) results.push({ title, id, url: BASE + href });
  });

  return results;
}

export async function getEpisodes(animeId: string): Promise<SenshiEpisode[]> {
  const cacheKey = `senshi:eps:${animeId}`;
  const cached = cacheGet<SenshiEpisode[]>(cacheKey);
  if (cached) return cached;

  const res = await http.get(`/episodes/${animeId}`, {
    headers: { Accept: 'application/json' },
  });

  const rows = Array.isArray(res.data) ? res.data : [];
  const episodes: SenshiEpisode[] = rows
    .map((ep: any) => {
      const num = Number(ep.ep_id ?? ep.episode_number ?? ep.num);
      return {
        num,
        id: `${animeId}:${num}`,
        title: ep.ep_title ?? `Episode ${num}`,
      };
    })
    .filter((ep: SenshiEpisode) => ep.num > 0);

  if (episodes.length > 0) cacheSet(cacheKey, episodes, 'episodes');
  return episodes;
}

function resolveEmbedType(embed: any): 'sub' | 'dub' | 'raw' {
  const status = String(embed.status ?? embed.type ?? embed.lang ?? embed.audio ?? '').toLowerCase();

  if (
    status.includes('dub') ||
    status.includes('english') ||
    status === 'en' ||
    status.includes('dubbed')
  ) {
    return 'dub';
  }

  if (status.includes('raw')) {
    return 'raw';
  }

  return 'sub';
}

export async function getServers(episodeId: string): Promise<SenshiServer[]> {
  if (episodeId.includes(':')) {
    const [animeId, epNum] = episodeId.split(':');
    const res = await http.get(`/episode-embeds/${animeId}/${epNum}`, {
      headers: { Accept: 'application/json' },
    });
    const embeds = Array.isArray(res.data) ? res.data : [];

    return embeds
      .map((embed: any, index: number) => {
        const type = resolveEmbedType(embed);
        const name = embed.status || embed.type || embed.lang || `Server ${index + 1}`;
        const sourceId = embed.url || embed.server2 || embed.serverFM || '';
        return sourceId ? { name, serverId: String(index + 1), sourceId, type } : null;
      })
      .filter(Boolean) as SenshiServer[];
  }

  const res = await ajax.get('/ajax/v2/episode/servers', {
    params: { episodeId },
  });

  const html = (res.data?.html || (typeof res.data === 'string' ? res.data : ''));
  const $ = cheerio.load(html);
  const servers: SenshiServer[] = [];

  $('[data-type="sub"] .server-item, .servers-sub .item, [class*="sub"] li[data-id]').each((_, el) => {
    const sourceId = $(el).attr('data-id') ?? '';
    const serverId = $(el).attr('data-server-id') ?? '';
    const name = $(el).text().trim() || 'Server';
    if (sourceId) servers.push({ name, serverId, sourceId, type: 'sub' });
  });

  $('[data-type="dub"] .server-item, .servers-dub .item, [class*="dub"] li[data-id]').each((_, el) => {
    const sourceId = $(el).attr('data-id') ?? '';
    const serverId = $(el).attr('data-server-id') ?? '';
    const name = $(el).text().trim() || 'Server';
    if (sourceId) servers.push({ name, serverId, sourceId, type: 'dub' });
  });

  $('[data-type="raw"] .server-item, .servers-raw .item, [class*="raw"] li[data-id]').each((_, el) => {
    const sourceId = $(el).attr('data-id') ?? '';
    const serverId = $(el).attr('data-server-id') ?? '';
    const name = $(el).text().trim() || 'Server';
    if (sourceId) servers.push({ name, serverId, sourceId, type: 'raw' });
  });

  return servers;
}

export async function getEmbedUrl(sourceId: string): Promise<EmbedResult | null> {
  if (/^https?:\/\//i.test(sourceId)) {
    return {
      embedUrl: sourceId,
      serverName: 'Senshi',
      type: sourceId.includes('.m3u8') ? 'hls' : 'iframe',
      // ninstream.com and similar CDNs whitelist senshi.live as the allowed
      // player origin. Always send senshi.live as Referer — both for sub and
      // dub streams — so the CDN's origin check passes.
      referer: BASE + '/',
    };
  }

  try {
    const res = await ajax.get('/ajax/v2/episode/sources', {
      params: { id: sourceId },
    });

    const data = res.data;

    if (data?.link) {
      return {
        embedUrl: data.link,
        serverName: data.server ?? 'unknown',
        type: data.type ?? 'iframe',
        referer: BASE + '/',
      };
    }

    if (data?.url) {
      return { embedUrl: data.url, serverName: 'server', type: 'iframe', referer: BASE + '/' };
    }

    return null;
  } catch {
    return null;
  }
}
