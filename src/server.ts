import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import routes from './routes';
import discordRelay from './discord-relay';
import imageMigrator from './image-migrator';

const app = express();
const PORT = parseInt(process.env.PORT || '3000');

app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_MAX || '60'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api', limiter);

// API routes
app.use('/api', routes);

// Discord webhook relay (PHP → Railway → Vercel bot → Discord)
app.use('/discord', discordRelay);

// One-off InfinityFree → R2 image migration tool (FTP-based). Delete this
// line + src/image-migrator.ts once the migration is done.
app.use('/migrate-images', imageMigrator);

// Serve static docs/tester
app.use(express.static(path.join(__dirname, '../public')));

// Catch-all → docs
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🟢 AniVault API running on http://localhost:${PORT}`);
  console.log(`📄 Docs + Tester: http://localhost:${PORT}/`);
  console.log(`🔗 API base:      http://localhost:${PORT}/api\n`);

  // Keep FlareSolverr alive on Render free tier (sleeps after 15min inactivity)
  const flaresolverrUrl = process.env.FLARESOLVERR_URL;
  if (flaresolverrUrl) {
    const ping = () => {
      fetch(flaresolverrUrl)
        .then(() => console.log('[pinger] FlareSolverr alive ✅'))
        .catch((e: any) => console.warn('[pinger] FlareSolverr ping failed:', e.message));
    };
    ping(); // ping immediately on startup
    setInterval(ping, 9 * 60 * 1000); // then every 9 minutes
    console.log(`🏓 FlareSolverr pinger active → ${flaresolverrUrl}`);
  }
});

export default app;
