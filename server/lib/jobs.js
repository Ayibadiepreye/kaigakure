import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { randomUUID } from 'node:crypto';
import { JOBS_DIR } from './paths.js';
import { downloadItem } from './extract.js';
import { fetchImage } from './net.js';

const jobs = new Map();

export function getJob(id) {
  return jobs.get(id);
}

export function listJobs() {
  return [...jobs.values()].map(publicJob);
}

function publicJob(j) {
  return {
    id: j.id,
    status: j.status,
    url: j.url,
    title: j.title,
    platform: j.platform,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt,
    progress: j.progress,
    files: j.files,
    error: j.error,
    options: j.options,
  };
}

const UNSAFE = /[\/:*?"<>|]/g;
const CONTROL = /[\u0000-\u001f\u007f]/g;

export function safeName(s, fallback = 'media') {
  const cleaned = String(s || '')
    .normalize('NFKD')
    .replace(CONTROL, '')
    .replace(UNSAFE, '')
    .replace(/\s+/g, '_')
    // Drop anything outside printable ASCII. Non-Latin names are fine on disk
    // but crash Node when they reach a Content-Disposition header.
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .replace(/\.+$/, '')
    .slice(0, 80);
  return cleaned || fallback;
}

/**
 * Build a Content-Disposition header value that survives any filename.
 *
 * ASCII names go in `filename="..."`; anything else uses RFC 5987
 * `filename*=UTF-8''...`, which is what modern browsers understand. Both are
 * sent when the name is non-ASCII so older clients still get a usable name.
 */
export function contentDisposition(filename) {
  const ascii = /^[\x20-\x7e]*$/.test(filename);
  if (ascii) {
    // Escape quotes and backslashes so a name containing `"` cannot break out.
    const esc = filename.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `attachment; filename="${esc}"`;
  }
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').slice(0, 40) || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Create and start a download job.
 * selection: array of { id, type, ...item } chosen by the user.
 */
export function createJob({ url, selection, options = {}, title }) {
  const id = randomUUID();
  const dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const job = {
    id,
    status: 'queued',
    url,
    title: title || 'Kaigakure',
    platform: null,
    createdAt: Date.now(),
    finishedAt: null,
    progress: { done: 0, total: selection.length, label: 'queued' },
    files: [],
    error: null,
    options,
    dir,
    folder: safeName(title || 'kaigakure'),
  };
  jobs.set(id, job);

  run(job, selection).catch((err) => {
    job.status = 'error';
    job.error = String(err?.message || err);
    job.finishedAt = Date.now();
  });

  return job;
}

async function run(job, selection) {
  job.status = 'running';
  const base = job.folder || safeName(job.title);
  const outDir = path.join(job.dir, base);
  fs.mkdirSync(outDir, { recursive: true });

  for (let i = 0; i < selection.length; i++) {
    const item = selection[i];
    job.progress = { done: i, total: selection.length, label: `downloading ${item.type}` };

    const stem = `${base}_${String(i + 1).padStart(2, '0')}`;
    // yt-dlp chooses the real container itself (webm vs mp4), so we let it
    // write with %(ext)s and read the true filename back off disk.
    const template = path.join(outDir, `${stem}.%(ext)s`);

    try {
      let produced = null;

      if ((item.source === 'telegram' || item.source === 'direct' || item.source === 'pinterest') && item.url) {
        // Signed / direct / Pinterest URLs: fetch straight, extension is known.
        const ext =
          item.type === 'audio'
            ? job.options.audioFormat || 'mp3'
            : item.ext || (item.type === 'video' ? 'mp4' : 'jpg');
        const outPath = path.join(outDir, `${stem}.${ext}`);
        await downloadItem(job.url, item, job.options, outPath);
        produced = outPath;
      } else if (item.type === 'photo' && item.url) {
        const ext = item.ext && item.ext.length <= 5 ? item.ext : 'jpg';
        const outPath = path.join(outDir, `${stem}.${ext}`);
        await fetchImage(item.url, outPath, job.url);
        produced = outPath;
      } else {
        produced = await downloadItem(job.url, item, job.options, template);
      }

      if (produced && fs.existsSync(produced)) {
        job.files.push({
          name: path.basename(produced),
          size: fs.statSync(produced).size,
          type: item.type,
        });
      } else {
        const fallback = fs
          .readdirSync(outDir)
          .filter((f) => f.startsWith(stem))
          .map((f) => path.join(outDir, f));
        if (fallback.length) {
          job.files.push({
            name: path.basename(fallback[0]),
            size: fs.statSync(fallback[0]).size,
            type: item.type,
          });
        } else {
          job.files.push({ name: stem, size: 0, type: item.type, failed: true, error: 'No file produced' });
        }
      }
    } catch (err) {
      job.files.push({
        name: stem,
        size: 0,
        type: item.type,
        failed: true,
        error: String(err?.message || err),
      });
    }
    job.progress = { done: i + 1, total: selection.length, label: `${item.type} done` };
  }

  job.status = 'complete';
  job.finishedAt = Date.now();
}

/** Bundle a job's files into a zip. Returns the zip path. */
export async function zipJob(job) {
  const zipPath = path.join(job.dir, `${job.folder || safeName(job.title)}.zip`);
  const folder = job.folder || safeName(job.title);
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    out.on('close', () => resolve(zipPath));
    out.on('error', reject);
    archive.on('error', reject);
    archive.pipe(out);
    for (const f of job.files) {
      const p = path.join(job.dir, folder, f.name);
      const direct = path.join(job.dir, f.name);
      const use = fs.existsSync(p) ? p : direct;
      if (fs.existsSync(use)) archive.file(use, { name: f.name });
    }
    archive.finalize();
  });
}

/** Remove a job and its files. */
export function deleteJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  try {
    fs.rmSync(job.dir, { recursive: true, force: true });
  } catch { /* best effort */ }
  jobs.delete(id);
  return true;
}

export { publicJob };
