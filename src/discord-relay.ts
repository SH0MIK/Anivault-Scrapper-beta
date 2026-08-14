// ── Discord Webhook Relay ─────────────────────────────────────────────────
//   POST /discord/relay        — PHP → Worker → Vercel bot (login/register events)
//   POST /discord/user-lookup  — Vercel bot → Worker (fire-and-forget)
//
// Env vars needed (wrangler vars / secrets):
//   VERCEL_BOT_URL, BOT_SECRET, SITE_URL, FLARESOLVERR_URL, DISCORD_APP_ID
//
// ⚠️ PORTED WITH A KNOWN GAP: the original used
// `new https.Agent({ rejectUnauthorized: false })` to skip TLS verification
// on the InfinityFree call. Workers' `fetch` has no equivalent — you cannot
// disable certificate verification at all. If InfinityFree's cert was
// actually invalid/self-signed, this endpoint will fail here in a way that
// has no workaround on Workers; it needs fixing at the source (a valid cert)
// or moving this specific call off Workers. Left as a plain fetch below.

import { Hono } from 'hono';
import http from './utils/http';

const app = new Hono();

// Cache InfinityFree's anti-bot cookie + UA for ~25 minutes.
// Same isolate-lifetime caveat as utils/fetch.ts's cfCache.
let ifCache: { cookies: string; userAgent: string; expiresAt: number } | null = null;

async function getInfinityFreeClearance(siteUrl: string): Promise<{ cookies: string; userAgent: string } | null> {
  const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || '';
  if (!FLARESOLVERR_URL) return null;

  if (ifCache && ifCache.expiresAt > Date.now()) return ifCache;

  try {
    const res = await http.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'request.get',
      url: siteUrl,
      maxTimeout: 60000,
    }, { timeout: 70000 });

    const solution = res.data?.solution;
    if (!solution) return null;

    const cookies = (solution.cookies as any[]).map((c: any) => `${c.name}=${c.value}`).join('; ');
    ifCache = { cookies, userAgent: solution.userAgent, expiresAt: Date.now() + 25 * 60 * 1000 };
    return ifCache;
  } catch (e: any) {
    console.error('[user-lookup] FlareSolverr failed:', e?.message);
    return null;
  }
}

async function fetchUserFromSite(siteUrl: string, username: string): Promise<any> {
  const apiUrl = `${siteUrl}/api/discord_user.php?username=${encodeURIComponent(username)}&secret=${process.env.BOT_SECRET}`;
  const clearance = await getInfinityFreeClearance(siteUrl);

  const response = await fetch(apiUrl, {
    headers: clearance
      ? { Cookie: clearance.cookies, 'User-Agent': clearance.userAgent }
      : { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
  });

  const text = await response.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    ifCache = null;
    throw new Error(`Non-JSON response (${response.status}): ${text.slice(0, 150)}`);
  }

  if (response.status !== 200 || !parsed.user) {
    throw { status: response.status, body: parsed };
  }
  return parsed.user;
}

function buildUserEmbed(profile: any) {
  const SITE_URL = 'https://www.anivault.co';
  const profileUrl = `${SITE_URL}/u/${encodeURIComponent(profile.username)}`;
  const displayId = profile.display_id ?? profile.id;
  const stats = profile.stats ?? {};
  const joined = profile.created_at
    ? new Date(profile.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : 'Unknown';
  const avgScore = stats.avg_score ? Number(stats.avg_score).toFixed(1) : 'N/A';
  const ROLE_BADGE: Record<string, string> = { OWNER: '👑 Owner', owner: '👑 Owner', admin: '🛡️ Admin', mod: '🔨 Mod', user: '👤 User' };

  return {
    title: `${profile.username}'s Profile`,
    description: `[View full profile on AniVault](${profileUrl})`,
    color: 0xF59E0B,
    url: profileUrl,
    thumbnail: profile.avatar_url ? { url: profile.avatar_url } : undefined,
    fields: [
      { name: '🆔 User #', value: `\`#${displayId}\``, inline: true },
      { name: '🎖️ Role', value: ROLE_BADGE[profile.role] ?? '👤 User', inline: true },
      { name: '📅 Joined', value: joined, inline: true },
      { name: '▶️ Watching', value: `${stats.watching ?? 0}`, inline: true },
      { name: '✅ Completed', value: `${stats.completed ?? 0}`, inline: true },
      { name: '📋 Plan to Watch', value: `${stats.plan_to_watch ?? 0}`, inline: true },
      { name: '⏸️ On Hold', value: `${stats.on_hold ?? 0}`, inline: true },
      { name: '❌ Dropped', value: `${stats.dropped ?? 0}`, inline: true },
      { name: '⭐ Avg Score', value: avgScore, inline: true },
      { name: '🎞️ Episodes Watched', value: `${stats.total_episodes ?? 0}`, inline: true },
      { name: '📚 Total Anime', value: `${stats.total ?? 0}`, inline: true },
    ],
    footer: { text: 'AniVault • User Profile' },
    timestamp: new Date().toISOString(),
  };
}

async function sendDiscordFollowUp(token: string, body: any) {
  const DISCORD_APP_ID = process.env.DISCORD_APP_ID || '';
  const url = `https://discord.com/api/v10/webhooks/${DISCORD_APP_ID}/${token}/messages/@original`;
  await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

app.post('/relay', async (c) => {
  if (c.req.header('x-bot-secret') !== process.env.BOT_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const vercelUrl = process.env.VERCEL_BOT_URL;
  if (!vercelUrl) return c.json({ error: 'VERCEL_BOT_URL not configured' }, 500);

  try {
    const body = await c.req.json();
    const response = await fetch(`${vercelUrl}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': process.env.BOT_SECRET! },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    return c.json(data, (response.status >= 400 ? response.status : 200) as any);
  } catch (err: any) {
    console.error('[discord-relay] Network error reaching bot:', err?.message);
    return c.json({ error: 'Relay failed', detail: err?.message }, 500);
  }
});

// Fire-and-forget from Vercel's perspective: acknowledge immediately, then
// keep working. On Express this "just worked" because the process stayed
// alive; on Workers the runtime can kill background work after the response
// is sent unless it's explicitly registered with `waitUntil()`.
app.post('/user-lookup', async (c) => {
  if (c.req.header('x-bot-secret') !== process.env.BOT_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const { username, token } = body || {};
  if (!username || !token) return c.json({ error: 'Missing username or token' }, 400);

  const doLookup = async () => {
    const siteUrl = process.env.SITE_URL || 'https://www.anivault.co';
    try {
      const user = await fetchUserFromSite(siteUrl, username);
      await sendDiscordFollowUp(token, { embeds: [buildUserEmbed(user)] });
      console.log(`[user-lookup] ✅ Sent profile for ${username}`);
    } catch (err: any) {
      console.error('[user-lookup] Failed:', err?.message || err);
      const status = err?.status;
      const content = status === 404
        ? `❌ User **${username}** not found on AniVault.`
        : '❌ Failed to fetch user info. Try again later.';
      try {
        await sendDiscordFollowUp(token, { content });
      } catch (e: any) {
        console.error('[user-lookup] Also failed to send error follow-up:', e?.message);
      }
    }
  };

  c.executionCtx.waitUntil(doLookup());
  return c.json({ accepted: true });
});

export default app;
