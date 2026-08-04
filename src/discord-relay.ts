// ── Discord Webhook Relay ─────────────────────────────────────────────────
// Routes:
//   POST /discord/relay        — PHP → Railway → Vercel bot (login/register events)
//   POST /discord/user-lookup  — Vercel bot → Railway (fire-and-forget)
//                                 Railway does the slow FlareSolverr + PHP work,
//                                 then PATCHes the Discord follow-up message itself.
//                                 (Vercel's 10s function limit can't wait for this,
//                                 so Railway owns the whole slow path end-to-end.)
//
// Env vars needed on Railway:
//   VERCEL_BOT_URL    = https://anivault-bot.vercel.app   (unused for user-lookup now, kept for /relay)
//   BOT_SECRET        = (same secret set on PHP config + Vercel bot)
//   SITE_URL          = https://www.anivault.co
//   FLARESOLVERR_URL  = https://anivault-flaresolverr.onrender.com
//   DISCORD_APP_ID    = your Discord application ID

import { Router, Request, Response } from 'express';
import axios from 'axios';
import https from 'https';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || '';
const DISCORD_APP_ID   = process.env.DISCORD_APP_ID || '';

// Cache InfinityFree's anti-bot cookie + UA for ~25 minutes
let ifCache: { cookies: string; userAgent: string; expiresAt: number } | null = null;

async function getInfinityFreeClearance(siteUrl: string): Promise<{ cookies: string; userAgent: string } | null> {
    if (!FLARESOLVERR_URL) return null;

    if (ifCache && ifCache.expiresAt > Date.now()) {
        return ifCache;
    }

    console.log('[user-lookup] Solving InfinityFree challenge via FlareSolverr...');
    try {
        const res = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get',
            url: siteUrl,
            maxTimeout: 60000,
        }, { timeout: 70000 });

        const solution = res.data?.solution;
        if (!solution) return null;

        const cookies = (solution.cookies as any[])
            .map((c: any) => `${c.name}=${c.value}`)
            .join('; ');

        ifCache = { cookies, userAgent: solution.userAgent, expiresAt: Date.now() + 25 * 60 * 1000 };
        console.log('[user-lookup] ✅ InfinityFree cookies cached for 25 minutes');
        return ifCache;
    } catch (e: any) {
        console.error('[user-lookup] FlareSolverr failed:', e?.message);
        return null;
    }
}

async function fetchUserFromSite(siteUrl: string, username: string): Promise<any> {
    const apiUrl = `${siteUrl}/api/discord_user.php?username=${encodeURIComponent(username)}&secret=${process.env.BOT_SECRET}`;
    const clearance = await getInfinityFreeClearance(siteUrl);

    const response = await axios.get(apiUrl, {
        timeout: 15000,
        httpsAgent,
        headers: clearance
            ? { 'Cookie': clearance.cookies, 'User-Agent': clearance.userAgent }
            : { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: [(data) => data],
    });

    let parsed: any;
    try {
        parsed = JSON.parse(response.data);
    } catch {
        ifCache = null; // force re-solve next time
        throw new Error(`Non-JSON response (${response.status}): ${String(response.data).slice(0, 150)}`);
    }

    if (response.status !== 200 || !parsed.user) {
        throw { status: response.status, body: parsed };
    }

    return parsed.user;
}

// Build the same embed shape the bot would have sent
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
    const url = `https://discord.com/api/v10/webhooks/${DISCORD_APP_ID}/${token}/messages/@original`;
    await axios.patch(url, body, { headers: { 'Content-Type': 'application/json' } });
}

const router = Router();

// ── POST /discord/relay ───────────────────────────────────────
router.post('/relay', async (req: Request, res: Response) => {
    if (req.headers['x-bot-secret'] !== process.env.BOT_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const vercelUrl = process.env.VERCEL_BOT_URL;
    if (!vercelUrl) {
        return res.status(500).json({ error: 'VERCEL_BOT_URL not configured' });
    }

    try {
        const response = await axios.post(`${vercelUrl}/api/event`, req.body, {
            headers: { 'Content-Type': 'application/json', 'x-bot-secret': process.env.BOT_SECRET! },
            timeout: 8000,
            validateStatus: () => true,
        });
        return res.status(response.status >= 400 ? response.status : 200).json(response.data);
    } catch (err: any) {
        console.error('[discord-relay] Network error reaching bot:', err?.message);
        return res.status(500).json({ error: 'Relay failed', detail: err?.message });
    }
});

// ── POST /discord/user-lookup ─────────────────────────────────
// Fire-and-forget from Vercel's perspective. Vercel sends username + the
// interaction token, gets an immediate 200 back, and Railway does the
// rest in the background — including sending the final Discord message.
router.post('/user-lookup', async (req: Request, res: Response) => {
    if (req.headers['x-bot-secret'] !== process.env.BOT_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { username, token } = req.body || {};
    if (!username || !token) {
        return res.status(400).json({ error: 'Missing username or token' });
    }

    // Acknowledge immediately — Vercel doesn't need to wait
    res.json({ accepted: true });

    // Do the slow work after responding
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
});

export default router;
