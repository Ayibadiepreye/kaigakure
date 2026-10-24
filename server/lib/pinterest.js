import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/**
 * Pinterest anonymous extractor.
 *
 * Why this exists: Pinterest's data API (`/resource/PinResource/get/` with
 * `field_set_key: unauth_react_main_pin`) is anonymous — it serves pin data to
 * any signed-out visitor. But pinterest.com's edge rejects requests whose TLS
 * fingerprint is not a real browser. `server/lib/pinterest_api.py` does the
 * fetching with `curl_cffi` impersonating Chrome; this file is the Node-side
 * glue that shapes the result into Kaigakure's normal item model.
 */

const PIN_RE = /^https?:\/\/(?:[^/]+\.)?pinterest\.[a-z.]+\/pin\/(\d+)(?:\?|$|\/)/i;
const BOARD_RE = /^https?:\/\/(?:[^/]+\.)?pinterest\.[a-z.]+\/([A-Za-z0-9_]+)\/([A-Za-z0-9_-]+)(?:\?|$|\/)/i;
const SEARCH_RE = /^https?:\/\/(?:[^/]+\.)?pinterest\.[a-z.]+\/search\/(?:pins|videos)\//i;

export function pinterestKind(rawUrl) {
  if (PIN_RE.test(rawUrl)) return 'pin';
  if (SEARCH_RE.test(rawUrl)) return 'search';
  if (BOARD_RE.test(rawUrl)) return 'board';
  return null;
}

let pyBin = null;
let pyEnv = null;

/** Resolve the venv python once; return null if unavailable. */
function python() {
  if (pyBin) return pyBin;
  const candidates = [
    process.env.KAIGAKURE_PYTHON,
    path.resolve(process.cwd(), '.venv', 'Scripts', 'python.exe'),
    path.resolve(process.cwd(), '.venv', 'bin', 'python'),
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = spawnSyncProbe(c);
      if (r) {
        pyBin = c;
        pyEnv = r;
        return c;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function spawnSyncProbe(bin) {
  const r = spawnSync(bin, ['-c', 'import curl_cffi; print("ok")'], { timeout: 15000 });
  return r.status === 0 && String(r.stdout).includes('ok') ? { ok: true } : null;
}

/** Call the Python bridge with a job, returning its parsed JSON. */
async function bridge(job) {
  const bin = python();
  if (!bin) {
    const e = new Error(
      'The Pinterest reader needs Python with curl_cffi. Run: pip install curl_cffi'
    );
    e.userFacing =
      'Pinterest support needs its Python helper (curl_cffi). Run `pip install curl_cffi` in the app environment.';
    throw e;
  }

  return new Promise((resolve, reject) => {
    const p = spawn(bin, [path.resolve(process.cwd(), 'server/lib/pinterest_api.py')], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(e));
    p.on('close', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        reject(new Error(`Pinterest helper produced no JSON: ${err.slice(0, 200)}`));
        return;
      }
      if (!parsed.ok) {
        const e = new Error(parsed.error || 'Pinterest read failed.');
        e.userFacing = `Pinterest: ${parsed.error}`.slice(0, 220);
        reject(e);
        return;
      }
      resolve(parsed.data);
    });
    p.stdin.write(JSON.stringify(job));
    p.stdin.end();
  });
}

/** Normalise the images dict into a clean list, largest first. */
function imageList(pin) {
  const out = [];
  const images = pin?.images;
  if (!images || typeof images !== 'object') return out;
  for (const [label, img] of Object.entries(images)) {
    if (!img || !img.url) continue;
    out.push({
      label,
      url: img.url,
      width: Number(img.width) || null,
      height: Number(img.height) || null,
      orig: label === 'orig',
    });
  }
  out.sort((a, b) => (b.height || 0) - (a.height || 0));
  return out;
}

function videoList(pin) {
  const out = [];
  const vl = pin?.videos?.video_list;
  if (!vl || typeof vl !== 'object') return out;
  for (const [id, v] of Object.entries(vl)) {
    if (!v || !v.url) continue;
    out.push({ format_id: id, url: v.url, width: v.width || null, height: v.height || null });
  }
  out.sort((a, b) => (b.height || 0) - (a.height || 0));
  return out;
}

function pinTitle(pin, index) {
  return (
    pin?.title ||
    pin?.grid_title ||
    pin?.closeup_description ||
    pin?.seo_description ||
    pin?.description ||
    `Pin ${index + 1}`
  );
}

function pinToItem(pin, index) {
  const images = imageList(pin);
  const videos = videoList(pin);
  const best = images.find((i) => i.orig) || images[0] || null;
  const title = pinTitle(pin, index);

  if (videos.length) {
    return {
      id: `pv${index}`,
      type: 'video',
      title: String(title).slice(0, 120),
      url: videos[0].url,
      thumbnail: best?.url || null,
      ext: 'mp4',
      variants: videos.map((v) => ({
        format_id: v.format_id,
        url: v.url,
        height: v.height,
        width: v.width,
        note: v.format_id,
      })),
      source: 'pinterest',
      pinterest: { images, videos },
    };
  }

  if (best) {
    return {
      id: `pp${index}`,
      type: 'photo',
      title: String(title).slice(0, 120),
      url: best.url,
      thumbnail: best.url,
      width: best.width,
      height: best.height,
      ext: 'jpg',
      variants: images.map((i) => ({
        format_id: i.label,
        url: i.url,
        width: i.width,
        height: i.height,
        note: `${i.label}${i.orig ? ' · original' : ''}`,
      })),
      source: 'pinterest',
      pinterest: { images, videos },
    };
  }

  return null;
}

/**
 * Download one Pinterest item. `item.variant.format_id` may name a rendition
 * (e.g. "orig"); otherwise the item's own URL is used.
 */
export async function fetchPinterestMedia(item, outPath) {
  const bin = python();
  if (!bin) throw new Error('Pinterest helper unavailable (curl_cffi missing)');

  const label = item.variant?.format_id;
  let url = item.url;
  if (label && item.pinterest?.images?.length) {
    const match = item.pinterest.images.find((i) => i.label === label);
    if (match) url = match.url;
  }

  const script = `
import sys, urllib.request
url = sys.argv[1]
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Referer': 'https://www.pinterest.com/'})
data = urllib.request.urlopen(req, timeout=60).read()
sys.stdout.buffer.write(data)
`;
  const res = await new Promise((resolve, reject) => {
    const p = spawn(bin, ['-c', script, url], { windowsHide: true, timeout: 60000 });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, buf: Buffer.concat(chunks) }));
  });

  if (res.code !== 0 || !res.buf.length) {
    throw new Error(`Pinterest media download failed (exit ${res.code})`);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, res.buf);
  return outPath;
}

/**
 * Probe a Pinterest link. Returns items in Kaigakure's normal shape.
 */
export async function probePinterest(rawUrl) {
  const kind = pinterestKind(rawUrl);
  if (!kind) {
    const e = new Error('Not a supported Pinterest link.');
    e.userFacing = 'Use a pin (/pin/…), board (/user/board/) or search (/search/pins/) link.';
    throw e;
  }

  let raw = [];
  let title = 'Pinterest';

  if (kind === 'pin') {
    const pinId = rawUrl.match(PIN_RE)[1];
    const pin = await bridge({ action: 'pin', url: rawUrl });
    if (!pin) {
      const e = new Error('Pinterest returned nothing for that pin.');
      e.userFacing =
        'Pinterest returned nothing for that pin. It may be private or deleted.';
      throw e;
    }
    raw = [pin];
    title = pinTitle(pin, 0);
  } else if (kind === 'board') {
    const [, username, slug] = rawUrl.match(BOARD_RE);
    raw = await bridge({ action: 'board', url: rawUrl, limit: 60 });
    title = `${username} · ${slug}`;
  } else {
    const q = new URL(rawUrl).searchParams.get('q');
    raw = await bridge({ action: 'search', url: rawUrl, limit: 40 });
    title = `Search: ${q || 'pins'}`;
  }

  const items = [];
  raw.forEach((pin, i) => {
    const item = pinToItem(pin, i);
    if (item) items.push(item);
  });

  if (!items.length) {
    const e = new Error('No downloadable media found in that Pinterest link.');
    e.userFacing = 'No photos or videos were found in that Pinterest link.';
    throw e;
  }

  const counts = {
    video: items.filter((i) => i.type === 'video').length,
    audio: 0,
    photo: items.filter((i) => i.type === 'photo').length,
  };

  return {
    platform: 'pinterest',
    platformName: 'Pinterest',
    platformColor: '#bd081c',
    title: String(title).slice(0, 120),
    description: null,
    author: null,
    thumbnail: items[0]?.thumbnail || null,
    duration: null,
    webpageUrl: rawUrl,
    counts,
    items,
    warnings: [],
    hasCookies: false,
    cookieHint: null,
  };
}
