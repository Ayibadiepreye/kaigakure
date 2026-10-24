import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { detectPlatform } from './platforms.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Referer rules per platform so CDNs that check the origin still serve us. */
function refererFor(rawUrl) {
  const p = detectPlatform(rawUrl);
  switch (p) {
    case 'instagram':
      return 'https://www.instagram.com/';
    case 'tiktok':
      return 'https://www.tiktok.com/';
    case 'facebook':
      return 'https://www.facebook.com/';
    case 'twitter':
      return 'https://x.com/';
    case 'pinterest':
      return 'https://www.pinterest.com/';
    case 'reddit':
      return 'https://www.reddit.com/';
    default:
      return null;
  }
}

/** Fetch a remote image to a local file. */
export async function fetchImage(url, outPath, sourceUrl) {
  const headers = { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' };
  const ref = refererFor(sourceUrl);
  if (ref) headers.Referer = ref;

  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('image fetch returned empty body');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return outPath;
}

/** Proxy a remote image through the server (adds correct Referer + CORS). */
export async function proxyImage(url, sourceUrl) {
  const headers = { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' };
  const ref = refererFor(sourceUrl);
  if (ref) headers.Referer = ref;
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { body: Readable.fromWeb(res.body), contentType: res.headers.get('content-type') || 'image/jpeg' };
}

/** Stream a remote file straight to the client (no temp file). */
export async function streamRemote(url, sourceUrl, res) {
  const headers = { 'User-Agent': UA };
  const ref = refererFor(sourceUrl);
  if (ref) headers.Referer = ref;
  const up = await fetch(url, { headers, redirect: 'follow' });
  if (!up.ok) throw new Error(`HTTP ${up.status}`);
  res.setHeader('Content-Type', up.headers.get('content-type') || 'application/octet-stream');
  const len = up.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  await pipeline(Readable.fromWeb(up.body), res);
}
