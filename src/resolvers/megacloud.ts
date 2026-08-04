import axios from 'axios';
import CryptoJS from 'crypto-js';

// AES keys reverse-engineered from Megacloud's player JS
// These change occasionally — check https://github.com/ghoshRitesh12/aniwatch-api for updates
const KEYS = {
  megacloud: {
    key: CryptoJS.enc.Utf8.parse('c1d17096f2ca11b7'),
    iv:  CryptoJS.enc.Utf8.parse('9d7759e7d9e83908'),
  },
  vidstreaming: {
    key: CryptoJS.enc.Utf8.parse('37911490979715163134003223491201'),
    iv:  CryptoJS.enc.Utf8.parse('54674138327930866480207815084989'),
  },
};

export interface StreamResult {
  m3u8: string;
  type: 'hls';
  subtitles: { lang: string; url: string; default?: boolean }[];
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
}

function decrypt(encrypted: string, keyPair: typeof KEYS.megacloud): string {
  return CryptoJS.AES.decrypt(encrypted, keyPair.key, {
    iv: keyPair.iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  }).toString(CryptoJS.enc.Utf8);
}

// Resolve Megacloud embed
export async function resolveMegacloud(embedUrl: string): Promise<StreamResult | null> {
  try {
    const url = new URL(embedUrl);
    const videoId = url.pathname.split('/e-1/')[1]?.split('?')[0]
                 ?? url.pathname.split('/').pop()?.split('?')[0];
    if (!videoId) return null;

    const apiBase = url.origin;

    const res = await axios.get(`${apiBase}/embed-2/ajax/e-1/getSources`, {
      params: { id: videoId },
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': embedUrl,
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
      },
      timeout: 10000,
    });

    const data = res.data;
    const keyPair = embedUrl.includes('vidstreaming') ? KEYS.vidstreaming : KEYS.megacloud;

    let m3u8 = '';

    if (typeof data.sources === 'string') {
      // Encrypted
      try {
        const decrypted = decrypt(data.sources, keyPair);
        const sources = JSON.parse(decrypted);
        m3u8 = sources[0]?.file ?? '';
      } catch {
        // Key may have rotated — return embed URL so caller can iframe it
        return null;
      }
    } else if (Array.isArray(data.sources)) {
      m3u8 = data.sources[0]?.file ?? '';
    }

    if (!m3u8) return null;

    const subtitles = (data.tracks ?? [])
      .filter((t: any) => t.kind === 'captions' || t.kind === 'subtitles')
      .map((t: any) => ({
        lang: t.label ?? 'Unknown',
        url: t.file,
        default: t.default ?? false,
      }));

    return {
      m3u8,
      type: 'hls',
      subtitles,
      intro: data.intro ?? undefined,
      outro: data.outro ?? undefined,
    };
  } catch (err) {
    console.error('[Megacloud] resolve error:', (err as Error).message);
    return null;
  }
}

// Resolve Vidstreaming / Gogo embed
export async function resolveVidstreaming(embedUrl: string): Promise<StreamResult | null> {
  try {
    const url = new URL(embedUrl);
    const videoId = url.searchParams.get('id') ?? url.pathname.split('/').pop() ?? '';

    const ajaxUrl = `${url.origin}/encrypt-ajax.php?id=${videoId}&alias=${videoId}`;

    const res = await axios.get(ajaxUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': embedUrl,
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 10000,
    });

    const data = res.data;
    if (!data?.data) return null;

    const decrypted = decrypt(data.data, KEYS.vidstreaming);
    const parsed = JSON.parse(decrypted);
    const sources = parsed?.source ?? parsed?.sources ?? [];
    const m3u8 = sources[0]?.file ?? sources[0]?.label ?? '';

    return m3u8 ? { m3u8, type: 'hls', subtitles: [] } : null;
  } catch {
    return null;
  }
}

// Generic resolver — detects which resolver to use based on URL
export async function resolveEmbed(embedUrl: string): Promise<StreamResult | null> {
  if (embedUrl.includes('vidstreaming') || embedUrl.includes('gogoplay')) {
    return resolveVidstreaming(embedUrl);
  }
  // Megacloud mirror domains rotate constantly (vidwish.live, rapid-cloud.co,
  // mcloud.to, etc.) without "megacloud" or "e-1" appearing anywhere in the
  // URL, even though they expose the same /embed-2/ajax/e-1/getSources API.
  // Previously this branch only fired on an exact substring match, so any
  // rotated domain fell through to `return null` and got mislabeled upstream
  // as "key may have rotated" even though resolution was never attempted.
  // Try Megacloud-style resolution for anything else; resolveMegacloud already
  // fails safe (returns null) if the host doesn't actually expose that API.
  return resolveMegacloud(embedUrl);
}
