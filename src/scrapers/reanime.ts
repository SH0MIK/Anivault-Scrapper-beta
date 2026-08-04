// ─────────────────────────────────────────────────────────────────
// ReAnime (reanime.to) scraper.
//
// NOTE: this replaces the previous sidecar-based implementation (which
// depended on a separate Python FastAPI service that wasn't actually
// wired into routes.ts anywhere). This version scrapes reanime.to and
// its flixcloud.cc embed directly — no extra service to run.
//
// reanime.to's embed page ships an obfuscated, per-request encryption
// scheme (WASM-derived keystream + AES-CBC) to protect its stream URLs.
// The decryption routine below is a direct port of the same logic — it
// mirrors reanime.to's own embed player rather than anything invented
// here, so if the site changes its obfuscation this will need updating.
// ─────────────────────────────────────────────────────────────────

import { buildTitles, getMedia, UA } from '../utils/providerCore';
import { cacheGet, cacheSet } from '../utils/cache';

const BASE = 'https://reanime.to';
const FLIX = 'https://flixcloud.cc';
const H = { 'User-Agent': UA, Accept: 'application/json, */*' };

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface EpItem {
  id: string;
  number: number;
  title: string;
  audio: 'sub' | 'dub';
}

export interface ReAnimeSubtitle {
  url: string;
  language: string;
  format: string;
  default?: boolean;
}

export interface ProviderStream {
  url: string;
  type: 'hls';
  server: string;
  subtitles: ReAnimeSubtitle[];
  thumbnails_vtt: string | null;
  intro?: { start: number; end: number; title: string } | null;
  outro?: { start: number; end: number; title: string } | null;
}

// ── crypto helpers ──────────────────────────────────────────────

async function sha256hex(s: string | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : s);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function b64toU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveFields(seed: string) {
  let e = seed;
  for (let i = 0; i < 3; i++) e = await sha256hex(e + i);
  let l = e;
  for (let i = 0; i < 3; i++) l = await sha256hex(l + i);
  return {
    keyField: 'kf_' + e.substring(8, 16),
    ivField: 'ivf_' + e.substring(16, 24),
    containerName: 'cd_' + e.substring(24, 32),
    arrayName: 'ad_' + e.substring(32, 40),
    objectName: 'od_' + e.substring(40, 48),
    tokenField: e.substring(48, 64) + '_' + e.substring(56, 64),
    keyFrag2Field: l.substring(0, 16) + '_' + l.substring(16, 24),
  };
}

function extractSsrObj(html: string): string {
  const m = html.match(/\{type:"data",data:(\{)/);
  if (!m) throw new Error('SSR data block not found');
  let depth = 0;
  const start = html.indexOf('{', (m.index ?? 0) + m[0].length - 1);
  for (let i = start; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      if (--depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error('SSR brace matching failed');
}

function parseJsLiteral(src: string): any {
  let i = 0;
  function ws() {
    while (i < src.length && /\s/.test(src[i])) i++;
  }
  function parseValue(): any {
    ws();
    if (src[i] === '{') return parseObject();
    if (src[i] === '[') return parseArray();
    if (src[i] === '"') return parseDStr();
    if (src[i] === "'") return parseSStr();
    if (src.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (src.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (src.startsWith('null', i)) {
      i += 4;
      return null;
    }
    if (src.startsWith('undefined', i)) {
      i += 9;
      return null;
    }
    if (src.startsWith('!0', i)) {
      i += 2;
      return true;
    }
    if (src.startsWith('!1', i)) {
      i += 2;
      return false;
    }
    const m = src.slice(i).match(/^-?[\d.]+([eE][+-]?\d+)?/);
    if (m) {
      i += m[0].length;
      return parseFloat(m[0]);
    }
    throw new Error(`JS parse error at pos ${i}: ...${src.slice(i, i + 20)}`);
  }
  function parseDStr(): string {
    let r = '';
    i++;
    while (i < src.length && src[i] !== '"') {
      if (src[i] === '\\') {
        i++;
        const e: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
        r += e[src[i]] ?? src[i];
        i++;
      } else r += src[i++];
    }
    i++;
    return r;
  }
  function parseSStr(): string {
    let r = '';
    i++;
    while (i < src.length && src[i] !== "'") {
      if (src[i] === '\\') {
        i++;
        r += src[i] === "'" ? "'" : ({ n: '\n', t: '\t', r: '\r', '\\': '\\' } as Record<string, string>)[src[i]] ?? src[i];
        i++;
      } else r += src[i++];
    }
    i++;
    return r;
  }
  function parseKey(): string {
    ws();
    if (src[i] === '"') return parseDStr();
    if (src[i] === "'") return parseSStr();
    const m = src.slice(i).match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
    if (m) {
      i += m[0].length;
      return m[0];
    }
    throw new Error(`Bad key at pos ${i}: ${src.slice(i, i + 20)}`);
  }
  function parseObject(): any {
    const obj: Record<string, any> = {};
    i++;
    ws();
    while (i < src.length && src[i] !== '}') {
      if (src[i] === ',') {
        i++;
        ws();
        continue;
      }
      const k = parseKey();
      ws();
      i++;
      obj[k] = parseValue();
      ws();
    }
    i++;
    return obj;
  }
  function parseArray(): any[] {
    const arr: any[] = [];
    i++;
    ws();
    while (i < src.length && src[i] !== ']') {
      if (src[i] === ',') {
        i++;
        ws();
        continue;
      }
      arr.push(parseValue());
      ws();
    }
    i++;
    return arr;
  }
  return parseValue();
}

function parseWasmDecrypt(wasmBytes: Uint8Array) {
  const b = wasmBytes;
  let pos = 8;
  while (pos < b.length) {
    const secId = b[pos++];
    let sz = 0,
      sh = 0,
      by;
    do {
      by = b[pos++];
      sz |= (by & 127) << sh;
      sh += 7;
    } while (by & 128);
    if (secId === 10) {
      pos++;
      let sbs = 0,
        sh2 = 0,
        by2;
      do {
        by2 = b[pos++];
        sbs |= (by2 & 127) << sh2;
        sh2 += 7;
      } while (by2 & 128);
      pos += sbs;
      break;
    }
    pos += sz;
  }
  let rbs = 0,
    sh3 = 0,
    by3;
  do {
    by3 = b[pos++];
    rbs |= (by3 & 127) << sh3;
    sh3 += 7;
  } while (by3 & 128);
  const r = b.slice(pos, pos + rbs);
  function leb(arr: Uint8Array, i: number): [number, number] {
    let v = 0,
      s = 0,
      b2;
    do {
      b2 = arr[i++];
      v |= (b2 & 127) << s;
      s += 7;
    } while (b2 & 128);
    return [v, i];
  }
  const XOR_END = [32, 2, 32, 5, 106, 45, 0, 0, 115, 33, 6];
  let txStart = -1;
  outer: for (let i = 0; i < r.length - XOR_END.length; i++) {
    for (let j = 0; j < XOR_END.length; j++) if (r[i + j] !== XOR_END[j]) continue outer;
    txStart = i + XOR_END.length;
    break;
  }
  if (txStart < 0) throw new Error('WASM: transform start not found');
  let txEnd = -1,
    step = 36;
  for (let i = txStart; i < r.length - 4; i++) {
    if (r[i] === 32 && r[i + 1] === 5 && r[i + 2] === 65) {
      const [val, ni] = leb(r, i + 3);
      if (r[ni] === 108) {
        txEnd = i;
        step = val;
        break;
      }
    }
  }
  if (txEnd < 0) throw new Error('WASM: keystream not found');
  const code = r.slice(txStart, txEnd);
  function transform(inputByte: number): number {
    let local6 = inputByte & 255;
    const stk: number[] = [];
    let i = 0;
    while (i < code.length) {
      const op = code[i++];
      if (op === 32) {
        const [idx, ni] = leb(code, i);
        i = ni;
        stk.push(idx === 6 ? local6 : 0);
      } else if (op === 33) {
        const [idx, ni] = leb(code, i);
        i = ni;
        const v = stk.pop()!;
        if (idx === 6) local6 = v & 255;
      } else if (op === 65) {
        const [v, ni] = leb(code, i);
        i = ni;
        stk.push(v);
      } else if (op === 106) {
        const b2 = stk.pop()!,
          a = stk.pop()!;
        stk.push((a + b2) & 255);
      } else if (op === 107) {
        const b2 = stk.pop()!,
          a = stk.pop()!;
        stk.push((a - b2 + 256) & 255);
      } else if (op === 113) {
        const b2 = stk.pop()!,
          a = stk.pop()!;
        stk.push(a & b2 & 255);
      } else if (op === 114) {
        const b2 = stk.pop()!,
          a = stk.pop()!;
        stk.push((a | b2) & 255);
      } else if (op === 115) {
        const b2 = stk.pop()!,
          a = stk.pop()!;
        stk.push((a ^ b2) & 255);
      } else if (op === 116) {
        const b2 = stk.pop()!,
          a = stk.pop()!;
        stk.push((a << (b2 & 7)) & 255);
      } else if (op === 118) {
        const b2 = stk.pop()!,
          a = stk.pop()!;
        stk.push((a >>> (b2 & 7)) & 255);
      }
    }
    return local6;
  }
  return { step, transform };
}

function runDecrypt(wasmBytes: Uint8Array, frag1: Uint8Array, kf2: Uint8Array, T: Uint8Array, seedInt: number): Uint8Array {
  const { step, transform } = parseWasmDecrypt(wasmBytes);
  const out = new Uint8Array(frag1.length);
  for (let i = 0; i < frag1.length; i++) {
    const c = (frag1[i] ^ kf2[i] ^ T[i]) & 255;
    out[i] = (transform(c) ^ (i * step + seedInt)) & 255;
  }
  return out;
}

async function decryptEmbed(html: string) {
  const raw = extractSsrObj(html);
  const data = parseJsLiteral(raw);
  const seed = data.obfuscation_seed;
  if (!seed) throw new Error('obfuscation_seed missing from embed data');
  const fields = await deriveFields(seed);
  const ocd = data.obfuscated_crypto_data;
  if (!ocd) throw new Error('obfuscated_crypto_data missing from embed data');
  const container = ocd[fields.containerName];
  if (!container) throw new Error(`containerName "${fields.containerName}" not found in embed data`);
  const arr = container[fields.arrayName];
  if (!arr) throw new Error(`arrayName "${fields.arrayName}" not found in embed data`);
  const obj = arr[0][fields.objectName];
  if (!obj) throw new Error(`objectName "${fields.objectName}" not found in embed data`);
  const frag1 = b64toU8(obj[fields.keyField]);
  const iv = b64toU8(obj[fields.ivField]);
  const kf2raw = data[fields.keyFrag2Field];
  if (!kf2raw) throw new Error('key fragment 2 missing from embed data');
  const kf2 = b64toU8(kf2raw);
  const token = data[fields.tokenField];
  if (!token) throw new Error('token field missing from embed data');

  const tokRes = await fetch(`${FLIX}/api/m3u8/${token}`, { headers: { ...H, Referer: `${BASE}/` } });
  if (!tokRes.ok) throw new Error(`Token API ${tokRes.status}`);
  const tokData: any = await tokRes.json();

  const vidKey = (await sha256hex(token + 'vid')).substring(0, 10);
  const keyKey = (await sha256hex(token + 'key')).substring(0, 10);
  const v_bytes = b64toU8(tokData[vidKey]);
  const T_bytes = b64toU8(tokData[keyKey]);
  if (!v_bytes.length || !T_bytes.length) throw new Error('Token API returned incomplete data');

  const seedInt = parseInt(seed.substring(0, 8), 16);
  const wPayload = b64toU8(data.w_payload ?? '');
  if (!wPayload.length) throw new Error('w_payload missing from embed data');

  const wasmOut = runDecrypt(wPayload, frag1, kf2, T_bytes, seedInt);

  const keyMat = await crypto.subtle.importKey('raw', wasmOut, { name: 'PBKDF2' }, false, ['deriveBits']);
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(seed), iterations: 1000, hash: 'SHA-256' }, keyMat, 256),
  );
  for (let i = 0; i < 32; i++) derived[i] ^= seed.charCodeAt(i % seed.length);
  const aesKeyBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', derived));
  const aesKey = await crypto.subtle.importKey('raw', aesKeyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, v_bytes);

  const url = dec.decode(plain).trim().replace(/\0+$/, '');
  if (!url.startsWith('http')) throw new Error(`Unexpected decrypted value: ${url.substring(0, 60)}`);

  return {
    url,
    subtitles: (data.subtitles ?? []) as ReAnimeSubtitle[],
    thumbnails_vtt: data.thumbnails_vtt ?? null,
    intro_chapter: data.intro_chapter ?? null,
    outro_chapter: data.outro_chapter ?? null,
  };
}

// ── site scraping ───────────────────────────────────────────────

async function searchReanime(query: string): Promise<any[]> {
  const res = await fetch(`${BASE}/api/v1/search?${new URLSearchParams({ q: query, limit: '10' })}`, { headers: H });
  if (!res.ok) throw new Error(`reanime search ${res.status}`);
  const data: any = await res.json();
  return Array.isArray(data?.results) ? data.results : [];
}

async function fetchAnimeDetail(animeId: string): Promise<any | null> {
  const res = await fetch(`${BASE}/api/v1/anime/${animeId}`, { headers: H });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

function extractAnilistIdFromCover(coverImage: any): number | null {
  const urls = [coverImage?.extra_large, coverImage?.large, coverImage?.medium].filter(Boolean);
  for (const url of urls) {
    const m = url.match(/anilist\.co\/.*\/bx(\d+)-/);
    if (m) return Number(m[1]);
  }
  return null;
}

async function resolveSeries(anilistId: number | string) {
  const cacheKey = `reanime:series:${anilistId}`;
  const cached = cacheGet<any>(cacheKey);
  if (cached) return cached;

  const media = await getMedia(anilistId);
  const malId = media.idMal ?? null;
  const queries = buildTitles(media).slice(0, 5);

  const candidates = new Map<string, any>();
  await Promise.all(
    queries.map(async (q) => {
      for (const r of await searchReanime(q).catch(() => [])) {
        if (r?.anime_id && !candidates.has(r.anime_id)) candidates.set(r.anime_id, r);
      }
    }),
  );

  for (const [id, r] of candidates) {
    const coverId = extractAnilistIdFromCover(r.cover_image);
    if (coverId && coverId === Number(anilistId)) {
      const data = {
        animeId: id,
        title: r.title?.english || r.title?.romaji || id,
        malId: null,
        subbed: Number.isFinite(r.subbed) ? r.subbed : null,
        dubbed: Number.isFinite(r.dubbed) ? r.dubbed : null,
        matchType: 'cover_image',
      };
      cacheSet(cacheKey, data, 'mapping');
      return data;
    }
  }

  const needsDetail = [...candidates.keys()].filter((id) => extractAnilistIdFromCover(candidates.get(id)?.cover_image) === null);
  const details = await Promise.all(needsDetail.map(async (id) => ({ id, detail: await fetchAnimeDetail(id).catch(() => null) })));

  for (const { id, detail } of details) {
    if (detail?.anilist_id && Number(detail.anilist_id) === Number(anilistId)) {
      const data = {
        animeId: id,
        title: detail.title?.english || detail.title?.romaji || candidates.get(id)?.title?.english || id,
        malId: detail.mal_id || null,
        subbed: Number.isFinite(detail.subbed) ? detail.subbed : null,
        dubbed: Number.isFinite(detail.dubbed) ? detail.dubbed : null,
        matchType: 'anilist',
      };
      cacheSet(cacheKey, data, 'mapping');
      return data;
    }
  }

  if (malId) {
    for (const { id, detail } of details) {
      if (detail?.mal_id && Number(detail.mal_id) === Number(malId)) {
        const data = {
          animeId: id,
          title: detail.title?.english || detail.title?.romaji || id,
          malId: Number(detail.mal_id),
          subbed: Number.isFinite(detail.subbed) ? detail.subbed : null,
          dubbed: Number.isFinite(detail.dubbed) ? detail.dubbed : null,
          matchType: 'mal',
        };
        cacheSet(cacheKey, data, 'mapping');
        return data;
      }
    }
  }

  throw new Error(`ReAnime: no confirmed match for AniList ${anilistId}`);
}

async function fetchEpisodesList(animeId: string): Promise<any[]> {
  const res = await fetch(`${BASE}/api/v1/anime/${animeId}/episodes?${new URLSearchParams({ limit: '2000' })}`, { headers: H });
  if (!res.ok) throw new Error(`reanime episodes ${res.status}`);
  const data: any = await res.json();
  return Array.isArray(data?.data) ? data.data : [];
}

export async function getReanimeEpisodes(anilistId: number | string) {
  const series = await resolveSeries(anilistId);
  const reanimeEps = await fetchEpisodesList(series.animeId);
  if (!reanimeEps.length) throw new Error(`ReAnime: no episodes found for AniList ${anilistId} (slug ${series.animeId})`);

  const hasSub = series.subbed == null || series.subbed > 0;
  const dubCount = series.dubbed ?? 0;
  const sub: EpItem[] = [];
  const dub: EpItem[] = [];
  for (const ep of reanimeEps) {
    const number = ep.episode_number;
    const title = ep.title || `Episode ${number}`;
    if (hasSub) sub.push({ id: `reanime:${anilistId}:sub:${number}`, number, title, audio: 'sub' });
    if (dubCount > 0 && number <= dubCount) dub.push({ id: `reanime:${anilistId}:dub:${number}`, number, title, audio: 'dub' });
  }
  sub.sort((a, b) => a.number - b.number);
  dub.sort((a, b) => a.number - b.number);

  return {
    meta: { animeId: series.animeId, title: series.title, malId: series.malId, source: 'reanime' },
    episodes: { sub, dub },
  };
}

export async function getReanimeWatch(anilistId: number | string, audio: 'sub' | 'dub', epNum: number) {
  const series = await resolveSeries(anilistId);
  const slug = series.animeId;
  const order: Record<string, number> = { 'HD-2': 0, 'HD-1': 1 };
  const byPrio = (arr: any[]) => arr.slice().sort((a, b) => (order[a.serverName] ?? 9) - (order[b.serverName] ?? 9));

  const [watchRes, flixRes] = await Promise.allSettled([
    fetch(`${BASE}/api/watch/${slug}/${epNum}`, { headers: H }).then((r) => {
      if (!r.ok) throw new Error(`watch ${r.status}`);
      return r.json();
    }),
    fetch(`${BASE}/api/flix/${anilistId}/${epNum}`, { headers: H }).then((r) => {
      if (!r.ok) throw new Error(`flix ${r.status}`);
      return r.json();
    }),
  ]);

  const watchData = watchRes.status === 'fulfilled' ? (watchRes.value as any) : null;
  const flixData = flixRes.status === 'fulfilled' ? (flixRes.value as any) : null;

  const links: any[] = [...(watchData?.episode_links ?? [])];
  if (flixData?.success && flixData?.servers) {
    const seen = new Set(links.map((s) => s['$id']));
    for (const s of flixData.servers) if (!seen.has(s['$id'])) links.push(s);
  }

  const audioTypes = audio === 'sub' ? ['sub', 's-sub'] : ['dub', 's-dub'];
  const servers = byPrio(links.filter((s) => audioTypes.includes(s.dataType)));
  if (!servers.length) throw new Error(`ReAnime: no ${audio} servers for "${series.title}" ep ${epNum}`);

  const embedRes = await fetch(servers[0].dataLink, { headers: { ...H, Referer: `${BASE}/` } });
  if (!embedRes.ok) throw new Error(`ReAnime: embed fetch failed (${embedRes.status})`);
  const stream = await decryptEmbed(await embedRes.text());

  const providerStream: ProviderStream = {
    url: stream.url,
    type: 'hls',
    server: servers[0].serverName || 'ReAnime',
    subtitles: stream.subtitles,
    thumbnails_vtt: stream.thumbnails_vtt,
    intro: stream.intro_chapter,
    outro: stream.outro_chapter,
  };

  return {
    streams: [providerStream],
    allServers: servers.map((s) => ({ name: s.serverName, type: s.dataType, embed: s.dataLink })),
  };
}
