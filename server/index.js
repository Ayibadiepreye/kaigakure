import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe } from './lib/extract.js';
import { createJob, getJob, listJobs, zipJob, deleteJob } from './lib/jobs.js';
import { proxyImage, streamRemote } from './lib/net.js';
import { detectPlatform, platformMeta, COOKIE_HINT, PLATFORMS } from './lib/platforms.js';
import { PUBLIC_DIR, cookiesExist, COOKIE_FILE } from './lib/paths.js';
import {
  SITES,
  listAccounts,
  loginSite,
  forgetAccount,
  refreshMerged,
  savePasted,
} from './lib/login.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(PUBLIC_DIR), { maxAge: '1h' }));

/** Health + capability probe so the UI can grey out impossible options. */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: '1.0.0',
    cookies: cookiesExist(),
    platforms: Object.entries(PLATFORMS)
      .filter(([k]) => k !== 'file')
      .map(([k, v]) => ({ key: k, name: v.name, color: v.color })),
  });
});

/** Probe a URL: what media exists, in which quality, what can be selected. */
app.post('/api/probe', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A URL is required.' });
  }
  let normalized = url.trim();
  if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;

  try {
    const platform = detectPlatform(normalized);
    const result = await probe(normalized);
    res.json({
      ...result,
      platformName: platformMeta(platform).name,
      platformColor: platformMeta(platform).color,
      cookieHint: platform && COOKIE_HINT[platform] ? COOKIE_HINT[platform] : null,
    });
  } catch (err) {
    const raw = String(err?.message || err);
    const userFacing = err?.userFacing || raw;
    // A post with nothing to download is not an error — say so plainly.
    const empty =
      /no video could be found|no media|nothing to download|no downloadable|no formats|not available|no entries/i.test(
        raw
      );
    res.status(empty ? 200 : 422).json({
      error: empty ? null : userFacing,
      empty: empty ? userFacing : null,
      platform: detectPlatform(normalized),
      platformName: platformMeta(detectPlatform(normalized)).name,
    });
  }
});

/** Start a download job with the user's selection. */
app.post('/api/download', (req, res) => {
  const { url, selection, options } = req.body || {};
  if (!url || !Array.isArray(selection) || !selection.length) {
    return res.status(400).json({ error: 'url and a non-empty selection are required.' });
  }
  const job = createJob({
    url,
    selection,
    options: options || {},
    title: req.body.title || 'kaigakure',
  });
  res.json({ id: job.id, status: job.status });
});

/** Poll job status. */
app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    files: job.files,
    error: job.error,
    title: job.title,
    platform: job.platform,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  });
});

app.get('/api/jobs', (req, res) => res.json({ jobs: listJobs() }));

/** Zip all files of a job. */
app.get('/api/jobs/:id/zip', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'complete') {
    return res.status(409).json({ error: 'Job is not complete yet.' });
  }
  const zipPath = await zipJob(job);
  const name = path.basename(zipPath);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  fs.createReadStream(zipPath).pipe(res);
});

/** Download a single produced file. */
app.get('/api/jobs/:id/file/:name', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  const safe = path.basename(req.params.name);
  const found = job.files.find((f) => f.name === safe);
  if (!found) return res.status(404).json({ error: 'File not found.' });
  const folder = job.folder || '';
  const filePath = path.join(job.dir, folder, safe);
  const alt = path.join(job.dir, safe);
  const use = fs.existsSync(filePath) ? filePath : alt;
  if (!fs.existsSync(use)) return res.status(404).json({ error: 'File missing on disk.' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
  fs.createReadStream(use).pipe(res);
});

app.delete('/api/jobs/:id', (req, res) => {
  res.json({ ok: deleteJob(req.params.id) });
});

/** Image proxy for previews (adds Referer + CORS for CDNs that block). */
app.get('/api/image', async (req, res) => {
  const { url, source } = req.query;
  if (!url) return res.status(400).end();
  try {
    const { body, contentType } = await proxyImage(String(url), source ? String(source) : undefined);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    body.pipe(res);
  } catch (err) {
    res.status(502).end(String(err?.message || err));
  }
});

/** Stream a direct media URL through the server (for video/audio previews). */
app.get('/api/stream', async (req, res) => {
  const { url, source } = req.query;
  if (!url) return res.status(400).end();
  try {
    await streamRemote(String(url), source ? String(source) : undefined, res);
  } catch (err) {
    if (!res.headersSent) res.status(502).end(String(err?.message || err));
  }
});

/** Cookie upload so gated platforms can be reached. */
app.post('/api/cookies', (req, res) => {
  const { cookies } = req.body || {};
  if (typeof cookies !== 'string' || cookies.length < 10) {
    return res.status(400).json({ error: 'Paste a cookies.txt export (Netscape format).' });
  }
  try {
    savePasted(cookies);
    res.json({ ok: true, bytes: cookies.length });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Could not save cookies' });
  }
});

/** Which sites have a saved session, and how many cookies each holds. */
app.get('/api/accounts', (req, res) => {
  res.json({ accounts: listAccounts(), cookies: cookiesExist() });
});

/** Start an interactive login in a real browser window. */
app.post('/api/login/:site', async (req, res) => {
  const { site } = req.params;
  if (!SITES[site]) {
    return res.status(400).json({ error: `Unknown site: ${site}` });
  }
  try {
    const result = await loginSite(site);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(422).json({ error: err?.userFacing || err?.message || 'Login failed' });
  }
});

/** Forget a saved session. */
app.delete('/api/login/:site', (req, res) => {
  const { site } = req.params;
  if (!SITES[site]) return res.status(400).json({ error: `Unknown site: ${site}` });
  forgetAccount(site);
  refreshMerged();
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Kaigakure listening on http://0.0.0.0:${PORT}`);
});
