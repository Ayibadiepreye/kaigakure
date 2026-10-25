import { randomUUID } from 'node:crypto';
import { probe } from './extract.js';
import { detectPlatform, platformMeta, COOKIE_HINT } from './platforms.js';

/**
 * Batch reading: probe many links at once.
 *
 * Why a separate module rather than looping in a route: probing is expensive.
 * Every URL spawns a Python process (yt-dlp or gallery-dl), and Telegram and
 * Pinterest additionally need a browser. On Render's free tier that is 512MB of
 * RAM and 0.1 CPU, so firing ten probes at once would thrash or OOM.
 *
 * So: bounded concurrency, and one bad link never fails the batch.
 */

/** Hard ceiling. Past this the run time stops being bearable. */
export const BATCH_LIMIT = 25;

/**
 * Links probed at the same time. 2 is deliberately conservative: yt-dlp plus a
 * Playwright browser can each hold a few hundred MB, and the free tier has
 * 512MB total. Raise this on a bigger box.
 */
export const BATCH_CONCURRENCY = Number(process.env.KAIGAKURE_BATCH_CONCURRENCY || 2);

/** Phrases that mean "this post has nothing", not "something broke". */
const EMPTY_RE =
  /no video could be found|no media|nothing to download|no downloadable|no formats|not available|no entries/i;

const batches = new Map();

/** Normalise one link. Returns null when it is not a usable URL. */
export function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Turn a pasted blob into a clean, de-duplicated list of links.
 *
 * Accepts an array or a string (split on newlines, commas or semicolons) so the
 * same helper serves both the API and the UI's textarea.
 */
export function parseBatchUrls(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\n\r,;]+/);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const u = normalizeUrl(item);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= BATCH_LIMIT) break;
  }
  return out;
}

export function getBatch(id) {
  return batches.get(id);
}

export function listBatches() {
  return [...batches.values()].map(publicBatch);
}

export function deleteBatch(id) {
  return batches.delete(id);
}

function publicBatch(b) {
  return {
    id: b.id,
    status: b.status,
    createdAt: b.createdAt,
    finishedAt: b.finishedAt,
    progress: b.progress,
    error: b.error,
    urls: b.urls,
    results: b.results,
  };
}

/** Create a batch and start it. Returns the batch handle. */
export function createBatchJob({ urls, options = {} }) {
  const id = randomUUID();
  const batch = {
    id,
    status: 'queued',
    createdAt: Date.now(),
    finishedAt: null,
    urls,
    options,
    results: urls.map((url) => ({ url, status: 'pending' })),
    progress: { done: 0, total: urls.length, label: 'queued' },
    error: null,
  };
  batches.set(id, batch);

  runBatch(batch).catch((err) => {
    batch.status = 'error';
    batch.error = String(err?.message || err);
    batch.finishedAt = Date.now();
  });

  return batch;
}

async function probeOne(url) {
  const platform = detectPlatform(url);
  const meta = platformMeta(platform);
  const data = await probe(url);

  return {
    url,
    status: 'ok',
    platform,
    platformName: meta.name,
    platformColor: meta.color,
    cookieHint: COOKIE_HINT[platform] || null,
    data,
  };
}

async function failOne(url, err) {
  const raw = String(err?.message || err);
  const platform = detectPlatform(url);
  const empty = EMPTY_RE.test(raw);

  return {
    url,
    status: empty ? 'empty' : 'error',
    platform,
    platformName: platformMeta(platform).name,
    error: empty ? raw : err?.userFacing || raw,
    empty: empty ? raw : null,
  };
}

async function runBatch(batch) {
  batch.status = 'running';

  let next = 0;
  let done = 0;
  const total = batch.urls.length;

  const worker = async () => {
    while (next < total) {
      const idx = next++;
      const url = batch.urls[idx];
      batch.results[idx] = { url, status: 'reading' };

      try {
        batch.results[idx] = await probeOne(url);
      } catch (err) {
        batch.results[idx] = await failOne(url, err);
      }

      done += 1;
      batch.progress = {
        done,
        total,
        label: `${done} of ${total} links read`,
      };
    }
  };

  const lanes = Math.min(BATCH_CONCURRENCY, total);
  await Promise.all(Array.from({ length: lanes }, () => worker()));

  batch.status = 'complete';
  batch.finishedAt = Date.now();
  batch.progress = { done: total, total, label: 'complete' };
}
