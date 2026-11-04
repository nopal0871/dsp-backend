'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3001;

const corsOptions = process.env.ALLOWED_ORIGIN
  ? { origin: process.env.ALLOWED_ORIGIN.split(',').map((s) => s.trim()) }
  : undefined;
app.use(cors(corsOptions));

// Binary yt-dlp: pakai yang diunduh build script (./yt-dlp) jika ada, kalau tidak pakai dari PATH.
function resolveYtDlp() {
  for (const name of ['yt-dlp', 'yt-dlp.exe']) {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p)) return p;
  }
  return 'yt-dlp';
}
const YTDLP = resolveYtDlp();

// Hanya izinkan URL video YouTube (cegah penyalahgunaan proxy untuk URL arbitrer).
const YT_URL_RE = /^https:\/\/(www\.|m\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]{11}([&?#].*)?$/;

function decodeEntities(s = '') {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- GET /api/search?q= ----------
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Parameter q wajib diisi' });

  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(500).json({ error: 'YOUTUBE_API_KEY belum diset di environment' });

  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    maxResults: '5',
    videoEmbeddable: 'true',
    q,
    key,
  });

  try {
    const r = await fetch('https://www.googleapis.com/youtube/v3/search?' + params.toString());
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: (data.error && data.error.message) || 'YouTube API error' });
    }
    const items = (data.items || []).map((it) => ({
      id: it.id.videoId,
      title: decodeEntities(it.snippet.title),
      channel: decodeEntities(it.snippet.channelTitle),
      thumbnail:
        (it.snippet.thumbnails.medium || it.snippet.thumbnails.default || {}).url || '',
    }));
    res.json(items);
  } catch (err) {
    console.error('[search]', err);
    res.status(502).json({ error: 'Gagal menghubungi YouTube API' });
  }
});

// ---------- GET /api/stream?url= ----------
app.get('/api/stream', (req, res) => {
  const url = String(req.query.url || '');
  if (!YT_URL_RE.test(url)) return res.status(400).json({ error: 'URL YouTube tidak valid' });

  const args = [
    '-f', 'bestaudio[ext=webm]/bestaudio',
    '--no-playlist',
    '--no-warnings',
    '-q',
    '-o', '-',
    '--',
    url,
  ];

  const proc = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  res.setHeader('Content-Type', 'audio/webm');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  let stderrTail = '';
  proc.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });

  proc.stdout.pipe(res);

  proc.on('error', (err) => {
    console.error('[stream] gagal menjalankan yt-dlp:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'yt-dlp tidak tersedia di server' });
    else res.end();
  });

  proc.on('close', (code) => {
    if (code !== 0 && code !== null) console.error(`[stream] yt-dlp exit ${code}: ${stderrTail}`);
    res.end();
  });

  // Matikan yt-dlp saat client memutus koneksi.
  const killProc = () => {
    if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
  };
  req.on('close', () => {
    if (!res.writableEnded && res.destroyed) killProc();
  });
  res.on('close', killProc);
});

app.listen(PORT, () => {
  console.log(`DSP-32 backend aktif di port ${PORT} (yt-dlp: ${YTDLP})`);
});
