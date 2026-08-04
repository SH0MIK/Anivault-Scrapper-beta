import { expectedCount, getMedia, UA } from '../utils/providerCore';

const BASE = 'https://2dhive.com';

export interface EpItem {
  id: string;
  number: number;
  title: string;
  audio: 'sub' | 'dub';
}

export interface ProviderStream {
  url: string;
  type: 'hls' | 'embed';
  server: string;
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`2dhive ${res.status}: ${url}`);
  return res.text();
}

function extractPlayerProps(html: string): any | null {
  const idx = html.indexOf('prefetchedHls');
  if (idx === -1) return null;
  const propsIdx = html.lastIndexOf('props="', idx);
  if (propsIdx === -1) return null;
  const valueIdx = propsIdx + 7;
  const endIdx = html.indexOf('"', valueIdx);
  if (endIdx === -1) return null;
  const raw = html
    .slice(valueIdx, endIdx)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 2dhive's Astro islands serialize props as [type, data] tuples.
function astroDecode(v: any): any {
  if (!Array.isArray(v)) return v;
  const [type, data] = v;
  if (type === 0) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return data;
    return Object.fromEntries(Object.entries(data).map(([k, val]) => [k, astroDecode(val)]));
  }
  if (type === 1) return Array.isArray(data) ? data.map(astroDecode) : data;
  return data;
}

function decodeProps(raw: any): any {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, astroDecode(v)]));
}

function parseEpisodeNums(html: string, malId: number): number[] {
  const re = new RegExp(`/episode\\?anime=${malId}&(?:amp;)?ep_num=(\\d+)`, 'gi');
  const nums = new Set<number>();
  for (const m of html.matchAll(re)) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}

async function fetchEpisodePage(malId: number, epNum: number): Promise<any> {
  const html = await fetchPage(`${BASE}/episode?anime=${malId}&ep_num=${epNum}`);
  const rawProps = extractPlayerProps(html);
  if (!rawProps) throw new Error(`2dhive: no player data for MAL ${malId} ep ${epNum}`);
  return decodeProps(rawProps);
}

async function getMalId(anilistId: number | string): Promise<number> {
  const media = await getMedia(anilistId);
  if (!media.idMal) throw new Error(`2dhive: no MAL ID found for AniList ${anilistId}`);
  return media.idMal;
}

export async function get2dhiveEpisodes(anilistId: number | string) {
  const media = await getMedia(anilistId);
  const malId = await getMalId(anilistId);
  const animeHtml = await fetchPage(`${BASE}/anime?anime=${malId}`);
  const epNums = parseEpisodeNums(animeHtml, malId);
  if (!epNums.length) throw new Error(`2dhive: no episodes found for AniList ${anilistId} (MAL ${malId})`);

  const props = await fetchEpisodePage(malId, epNums[0]);
  const hasDub = Boolean(props.prefetchedHls?.dub?.content);
  const expected = expectedCount(media);

  const sub: EpItem[] = [];
  const dub: EpItem[] = [];
  for (const num of epNums) {
    if (expected && num > expected) continue;
    sub.push({ id: `2dhive:${anilistId}:sub:${num}`, number: num, title: `Episode ${num}`, audio: 'sub' });
    if (hasDub) dub.push({ id: `2dhive:${anilistId}:dub:${num}`, number: num, title: `Episode ${num}`, audio: 'dub' });
  }

  return {
    meta: { malId, source: '2dhive', numbering: 'standard', episodeOffset: 0 },
    episodes: { sub, dub },
  };
}

// The site pre-renders its own signed HLS playlist server-side (not a
// separate embed page), so the "stream" for the HLS entry is served by
// our own proxy route rather than linked out to 2dhive directly — this
// mirrors 2dhive's own /stream/2dhive/:id/:audio/:ep passthrough.
export async function get2dhiveHlsContent(anilistId: number | string, audio: 'sub' | 'dub', epNum: number): Promise<string | null> {
  const malId = await getMalId(anilistId);
  const props = await fetchEpisodePage(malId, epNum);
  return (audio === 'dub' ? props.prefetchedHls?.dub?.content : props.prefetchedHls?.sub?.content) ?? null;
}

export async function get2dhiveWatch(anilistId: number | string, audio: 'sub' | 'dub', epNum: number) {
  const malId = await getMalId(anilistId);
  const props = await fetchEpisodePage(malId, epNum);
  const content = audio === 'dub' ? props.prefetchedHls?.dub?.content : props.prefetchedHls?.sub?.content;

  const streams: ProviderStream[] = [];
  if (content) {
    streams.push({
      url: `/api/v2/stream/2dhive/${anilistId}/${audio}/${epNum}`,
      type: 'hls',
      server: `2dHive HLS ${audio.toUpperCase()}`,
    });
  }

  streams.push({
    url: `https://megaplay.buzz/stream/mal/${malId}/${epNum}/${audio === 'dub' ? 'dub' : 'sub'}`,
    type: 'embed',
    server: audio === 'dub' ? 'MegaPlay Dub' : 'MegaPlay Sub',
  });

  if (!streams.length) throw new Error(`2dhive: no streams found for AniList ${anilistId} ep ${epNum}`);
  return { streams };
}
