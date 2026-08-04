// ── Image Migration Tool (one-off) ────────────────────────────────────────
// Pulls assets/img/anime-library off InfinityFree over FTP — NOT HTTP, so it
// doesn't touch InfinityFree's Hits or CPU quota — and re-serves it as zip
// batches from Railway instead. Built for the InfinityFree → R2 migration.
//
// Routes:
//   GET /migrate-images/?key=...            — HTML page: file count + batch links
//   GET /migrate-images/batch?key=...&batch=1&size=1000  — streams a zip
//   GET /migrate-images/manifest?key=...    — CSV: filename,anime_id,size_bytes
//
// Env vars needed on Railway:
//   FTP_HOST         = ftpupload.net  (from InfinityFree's FTP Details page)
//   FTP_USER         = your InfinityFree FTP username
//   FTP_PASSWORD     = your InfinityFree FTP password
//   FTP_REMOTE_DIR   = /anivault.co/htdocs/assets/img/anime-library
//   MIGRATE_ACCESS_KEY = any password you make up, keeps this endpoint private
//
// NOTE: the file list comes from anime-image-manifest.json (generated from
// the anime_images DB table), NOT from an FTP directory listing. InfinityFree's
// FTP server silently truncates `LIST` output on directories this large
// (was returning ~5,000 of 12,474 files), so we bake in the exact expected
// filenames instead and only use FTP for the actual per-file downloads.
//
// DELETE THIS FILE (and remove the app.use('/migrate-images', ...) line in
// server.ts) once the migration is done — it holds FTP creds in env vars.

import { Router, Request, Response } from 'express';
import { Client } from 'basic-ftp';
import archiver from 'archiver';
import { PassThrough } from 'stream';
import manifest from './anime-image-manifest.json';

const FTP_HOST = process.env.FTP_HOST || '';
const FTP_USER = process.env.FTP_USER || '';
const FTP_PASSWORD = process.env.FTP_PASSWORD || '';
const FTP_REMOTE_DIR = process.env.FTP_REMOTE_DIR || '/htdocs/assets/img/anime-library';
const ACCESS_KEY = process.env.MIGRATE_ACCESS_KEY || '';

function checkKey(req: Request, res: Response): boolean {
  if (!ACCESS_KEY) {
    res.status(500).send('MIGRATE_ACCESS_KEY env var not set on Railway.');
    return false;
  }
  if (req.query.key !== ACCESS_KEY) {
    res.status(403).send('Missing or wrong ?key=');
    return false;
  }
  return true;
}

interface RemoteFile {
  name: string;
  anime_id: string;
}

function getFileList(): RemoteFile[] {
  return (manifest as { anime_id: string; filename: string }[])
    .map((m) => ({ name: m.filename, anime_id: m.anime_id }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

async function downloadToBuffer(client: Client, remotePath: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const pass = new PassThrough();
  pass.on('data', (chunk: Buffer) => chunks.push(chunk));
  const donePromise = new Promise<void>((resolve, reject) => {
    pass.on('end', () => resolve());
    pass.on('error', reject);
  });
  await client.downloadTo(pass, remotePath);
  await donePromise;
  return Buffer.concat(chunks);
}

const router = Router();

router.get('/', (req: Request, res: Response) => {
  if (!checkKey(req, res)) return;

  const files = getFileList();
  const batchSize = Math.max(50, Math.min(2000, parseInt(String(req.query.size), 10) || 1000));
  const total = files.length;
  const batchCount = Math.ceil(total / batchSize);
  const key = encodeURIComponent(String(req.query.key));

  let batchLinks = '';
  for (let b = 1; b <= batchCount; b++) {
    const start = (b - 1) * batchSize + 1;
    const end = Math.min(b * batchSize, total);
    batchLinks += `<a class="batch" href="/migrate-images/batch?key=${key}&batch=${b}&size=${batchSize}">Batch ${b} <span>${start}\u2013${end}</span></a>`;
  }

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AniVault Image Migrator</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:2rem;}
    .wrap{max-width:820px;margin:0 auto;}
    h1{font-size:1.3rem;}
    .stats{display:flex;gap:1rem;margin:1rem 0;flex-wrap:wrap;}
    .stat{background:#1a1d24;border:1px solid #2a2e37;border-radius:10px;padding:.8rem 1.1rem;flex:1;min-width:140px;}
    .stat b{display:block;font-size:1.2rem;}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.5rem;margin-top:1rem;}
    .batch{background:#1a1d24;border:1px solid #2a2e37;border-radius:8px;padding:.6rem .8rem;color:#e6e6e6;text-decoration:none;display:flex;justify-content:space-between;font-size:.85rem;}
    .batch:hover{border-color:#4f7cff;}
    .batch span{color:#9aa0a6;}
    .note{background:#14241c;border:1px solid #1f4a30;color:#8ae0a8;border-radius:8px;padding:.8rem 1rem;font-size:.85rem;}
  </style></head><body><div class="wrap">
  <h1>AniVault Image Migrator</h1>
  <div class="note">File list comes from the DB manifest (not FTP listing, which truncates on this host) \u2014 this does not touch your InfinityFree Hits or CPU quota. Zips are built here on Railway and streamed to you.</div>
  <div class="stats">
    <div class="stat"><b>${total.toLocaleString()}</b>Images</div>
    <div class="stat"><b>${batchCount}</b>Batches @ ${batchSize}/zip</div>
  </div>
  <div class="grid">${batchLinks}</div>
  </div></body></html>`);
});

router.get('/batch', async (req: Request, res: Response) => {
  if (!checkKey(req, res)) return;

  const batchSize = Math.max(50, Math.min(2000, parseInt(String(req.query.size), 10) || 1000));
  const batch = Math.max(1, parseInt(String(req.query.batch), 10) || 1);

  const files = getFileList();
  const offset = (batch - 1) * batchSize;
  const slice = files.slice(offset, offset + batchSize);
  if (slice.length === 0) return res.status(404).send('Batch out of range.');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="anivault-images-batch-${batch}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err: any) => {
    console.error('[image-migrator] archive error', err);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  archive.pipe(res);

  const client = new Client();
  client.ftp.verbose = false;
  try {
    await client.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASSWORD, secure: false });
    for (const f of slice) {
      const remotePath = FTP_REMOTE_DIR.replace(/\/$/, '') + '/' + f.name;
      try {
        const buf = await downloadToBuffer(client, remotePath);
        archive.append(buf, { name: f.name });
      } catch (fileErr: any) {
        console.error('[image-migrator] Skipping file (download failed):', f.name, fileErr.message);
      }
    }
  } finally {
    client.close();
  }

  await archive.finalize();
});

router.get('/manifest', (req: Request, res: Response) => {
  if (!checkKey(req, res)) return;
  const files = getFileList();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="anivault-images-manifest.csv"');
  let csv = 'filename,anime_id\n';
  for (const f of files) {
    csv += `${f.name},${f.anime_id}\n`;
  }
  res.send(csv);
});

export default router;
