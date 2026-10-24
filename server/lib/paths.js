import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..', '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = process.env.KAIGAKURE_DATA || path.join(ROOT, 'data');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const JOBS_DIR = path.join(DATA_DIR, 'jobs');

for (const dir of [DATA_DIR, TMP_DIR, JOBS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const COOKIE_FILE = process.env.KAIGAKURE_COOKIES || path.join(DATA_DIR, 'cookies.txt');

/** Resolve a working Python that has yt-dlp + gallery-dl installed. */
export function pythonBin() {
  if (process.env.KAIGAKURE_PYTHON) return process.env.KAIGAKURE_PYTHON;
  const candidates = [
    path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(ROOT, '.venv', 'bin', 'python'),
    path.join(ROOT, 'venv', 'Scripts', 'python.exe'),
    path.join(ROOT, 'venv', 'bin', 'python'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** Locate ffmpeg so yt-dlp can mux and extract audio. */
export function ffmpegPath() {
  if (process.env.KAIGAKURE_FFMPEG && fs.existsSync(process.env.KAIGAKURE_FFMPEG)) {
    return process.env.KAIGAKURE_FFMPEG;
  }
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'hermes', 'tools'),
    path.join(ROOT, 'bin'),
    '/usr/local/bin',
    '/usr/bin',
  ];
  for (const root of roots) {
    if (!root) continue;
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      for (const ext of exts) {
        const p = path.join(root, e.name, `ffmpeg${ext}`);
        if (fs.existsSync(p)) return p;
        const p2 = path.join(root, e.name, 'bin', `ffmpeg${ext}`);
        if (fs.existsSync(p2)) return p2;
      }
    }
  }
  return null;
}

/** PATH additions so child processes can find ffmpeg. */
export function pathEnv() {
  const ff = ffmpegPath();
  if (!ff) return {};
  const dir = path.dirname(ff);
  const sep = process.platform === 'win32' ? ';' : ':';
  const current = process.env.PATH || '';
  if (current.split(sep).includes(dir)) return {};
  return { PATH: `${dir}${sep}${current}` };
}

export function cookiesExist() {
  try {
    const st = fs.statSync(COOKIE_FILE);
    return st.size > 40;
  } catch {
    return false;
  }
}
