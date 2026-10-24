import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.js';
import { pythonBin, pathEnv, COOKIE_FILE, cookiesExist } from './paths.js';
import { SITES, accountFile, accountExists } from './login.js';
import { detectPlatform } from './platforms.js';

/** Media file extensions we can serve directly without any extractor. */
const DIRECT_EXT =
  /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|aac|wav|flac|ogg|opus|jpe?g|png|gif|webp|avif|bmp|heic)(\?|#|$)/i;

const IMAGE_EXT = /^(jpe?g|png|gif|webp|avif|bmp|heic)$/;
const AUDIO_EXT = /^(mp3|m4a|aac|wav|flac|ogg|opus)$/;

export function isDirectFile(url) {
  try {
    const u = new URL(url);
    return DIRECT_EXT.test(u.pathname + (u.search || ''));
  } catch {
    return false;
  }
}

/** Probe a direct file URL: we know exactly what it is, no extractor needed. */
export function probeDirectFile(rawUrl) {
  const u = new URL(rawUrl);
  const ext = (u.pathname.match(DIRECT_EXT)?.[1] || '').toLowerCase();
  const isImage = IMAGE_EXT.test(ext);
  const isAudio = AUDIO_EXT.test(ext);
  const name = decodeURIComponent(u.pathname.split('/').pop() || 'file');

  return {
    platform: 'file',
    platformName: 'Direct file',
    platformColor: '#64748b',
    title: name,
    description: null,
    author: null,
    thumbnail: isImage ? rawUrl : null,
    duration: null,
    webpageUrl: rawUrl,
    counts: {
      video: !isImage && !isAudio ? 1 : 0,
      photo: isImage ? 1 : 0,
      audio: isAudio ? 1 : 0,
    },
    items: [
      {
        id: 'd0',
        type: isImage ? 'photo' : isAudio ? 'audio' : 'video',
        title: name,
        url: rawUrl,
        ext: ext || 'bin',
        variants: [],
        source: 'direct',
      },
    ],
    warnings: [],
    hasCookies: cookiesExist(),
    cookieHint: null,
  };
}

/**
 * Pick the best cookie file for a platform: the site's own saved session if it
 * has one, otherwise the merged cookies.txt. Keeping them separate means an
 * Instagram session is never sent to Reddit.
 */
function cookieFileFor(platform) {
  const site = SITES[platform];
  if (site) {
    const f = accountFile(platform);
    if (f && accountExists(platform)) return f;
  }
  return cookiesExist() ? COOKIE_FILE : null;
}

/** Common yt-dlp flags: quiet, no warnings, cookies when available. */
function ytdlpBaseArgs(platform) {
  const args = ['-m', 'yt_dlp', '--no-warnings', '--ignore-config'];
  const cf = cookieFileFor(platform);
  if (cf) args.push('--cookies', cf);
  return args;
}

function galleryArgs(platform) {
  const args = ['-m', 'gallery_dl', '--dump-json', '--no-download', '--quiet'];
  const cf = cookieFileFor(platform);
  if (cf) args.push('--cookies', cf);
  return args;
}

function parseJsonLoose(text) {
  // yt-dlp/gallery-dl can emit non-strict JSON (control chars in descriptions).
  const cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/** Storyboards, sprite sheets and MHTML wrappers are not real photos. */
function isStoryboard(f) {
  const note = String(f.format_note || '').toLowerCase();
  const url = String(f.url || '');
  return (
    note.includes('storyboard') ||
    note.includes('mhtml') ||
    url.includes('/sb/') ||
    url.includes('storyboard') ||
    String(f.protocol || '').startsWith('mhtml')
  );
}

/**
 * Pull image URLs out of gallery-dl JSON.
 *
 * gallery-dl emits a stream of [index, payload] pairs, where the index is a
 * progress counter (not an id). The payload is either a metadata object or an
 * error. Some extractors report `category` as the site name (e.g. "imgur")
 * rather than "image", so we also accept a media-looking URL.
 */
function galleryImages(objs) {
  const out = [];
  for (const pair of objs) {
    // Unwrap the [count, object] envelope.
    const o = Array.isArray(pair) ? pair[1] : pair;
    if (!o || typeof o !== 'object' || o.error) continue;

    const url = o.url || (Array.isArray(o.images) ? o.images[0] : null);
    if (!url || typeof url !== 'string') continue;

    // Skip anything that is clearly not a picture or short video.
    const category = String(o.category || '').toLowerCase();
    const looksImage = /\.(jpe?g|png|gif|webp|avif|bmp)(\?|$)/i.test(url);
    const looksVideo = /\.(mp4|webm|mov|mkv)(\?|$)/i.test(url);
    const isImageCat = category.startsWith('image') || category === 'imgur' || category === 'artstation' || category === 'flickr';
    if (!isImageCat && !looksImage && !looksVideo) continue;

    out.push({
      url,
      width: o.width ?? null,
      height: o.height ?? null,
      ext: (o.filename && o.filename.split('.').pop()) || (looksVideo ? 'mp4' : 'jpg'),
      type: looksVideo ? 'video' : 'photo',
      category,
    });
  }
  return out;
}

/** Best thumbnail URL yt-dlp knows about. */
function bestThumbnail(info) {
  if (info.thumbnail) return info.thumbnail;
  const thumbs = (info.thumbnails || []).filter((t) => t && t.url);
  if (!thumbs.length) return null;
  return (
    thumbs.slice().sort((a, b) => (b.height || 0) - (a.height || 0))[0].url ||
    thumbs[thumbs.length - 1].url
  );
}

/** Build the `variants` list for a yt-dlp format list (largest first). */
function buildVariants(videoFormats) {
  const seen = new Set();
  const variants = [];
  for (const f of videoFormats) {
    if (seen.has(f.format_id)) continue;
    seen.add(f.format_id);
    variants.push({
      format_id: f.format_id,
      ext: f.ext || 'mp4',
      height: f.height ?? null,
      width: f.width ?? null,
      fps: f.fps ?? null,
      filesize: f.filesize ?? f.filesize_approx ?? null,
      vcodec: f.vcodec,
      hasAudio: !!(f.acodec && f.acodec !== 'none'),
      note: f.format_note || f.format_id,
    });
  }
  variants.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.fps || 0) - (a.fps || 0));
  return variants;
}

/**
 * Turn a yt-dlp info dict into logical media items.
 *
 * One item = one piece of content (a video, an audio track, or a photo).
 * Each video/audio item carries its available renditions in `variants`, so
 * the UI shows one card per thing rather than one card per codec.
 *
 * `info` may be a single video or a playlist; for a playlist each entry is
 * classified on its own — an entry with formats is a video, an entry without
 * any is a photo (Instagram / TikTok carousels).
 */
function ytdlpItems(info) {
  const items = [];
  const formats = (info.formats || []).filter((f) => !isStoryboard(f) && f && f.url);
  const thumb = bestThumbnail(info);

  // ---- video: one item, many renditions -------------------------------
  const videoFormats = formats.filter((f) => f.vcodec && f.vcodec !== 'none');
  if (videoFormats.length) {
    const variants = buildVariants(videoFormats);
    items.push({
      id: 'v0',
      type: 'video',
      title: 'Video',
      thumbnail: thumb,
      duration: info.duration ?? null,
      variants,
      source: 'yt-dlp',
    });
  }

  // ---- audio: one item, its own renditions ----------------------------
  const audioFormats = formats.filter(
    (f) => (f.acodec && f.acodec !== 'none') && (!f.vcodec || f.vcodec === 'none')
  );
  if (audioFormats.length) {
    const seen = new Set();
    const variants = [];
    for (const f of audioFormats) {
      if (seen.has(f.format_id)) continue;
      seen.add(f.format_id);
      variants.push({
        format_id: f.format_id,
        ext: f.ext || 'm4a',
        abr: f.abr || null,
        filesize: f.filesize ?? f.filesize_approx ?? null,
        note: f.format_note || f.format_id,
      });
    }
    variants.sort((a, b) => (b.abr || 0) - (a.abr || 0));
    items.push({
      id: 'a0',
      type: 'audio',
      title: 'Audio track',
      thumbnail: thumb,
      duration: info.duration ?? null,
      variants,
      source: 'yt-dlp',
    });
  }

  // ---- playlist entries ----------------------------------------------
  // An entry with its own formats is a video (X posts several videos, YouTube
  // playlists). An entry with no formats at all is a photo (Instagram / TikTok
  // carousels). Assuming "entry == photo" silently turned real videos into
  // zero-variant photos, so classify on the entry's own data.
  const entries = (info.entries || []).filter(Boolean);
  entries.forEach((e, i) => {
    const eFormats = (e.formats || []).filter((f) => !isStoryboard(f) && f && f.url);
    const eVideo = eFormats.filter((f) => f.vcodec && f.vcodec !== 'none');

    if (eVideo.length) {
      const eThumb = bestThumbnail(e) || thumb;
      items.push({
        id: e.id || `v${i}`,
        type: 'video',
        title: e.title || info.title || `Video ${i + 1}`,
        thumbnail: eThumb,
        duration: e.duration ?? null,
        variants: buildVariants(eVideo),
        source: 'yt-dlp',
      });
      return;
    }

    const url = e.url || e.thumbnail || (e.thumbnails || []).at(-1)?.url || null;
    if (!url) return;
    items.push({
      id: e.id || `p${items.length}`,
      type: 'photo',
      title: e.title || `Photo ${items.length + 1}`,
      url,
      thumbnail: e.thumbnail || url,
      width: e.width ?? null,
      height: e.height ?? null,
      ext: 'jpg',
      variants: [],
      source: 'yt-dlp',
    });
  });

  // ---- photos: standalone image formats in the format list ------------
  const imageFormats = formats.filter(
    (f) =>
      (!f.vcodec || f.vcodec === 'none') &&
      (!f.acodec || f.acodec === 'none') &&
      /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(String(f.url || ''))
  );
  for (const f of imageFormats) {
    items.push({
      id: `f${items.length}`,
      type: 'photo',
      title: `Photo ${items.length + 1}`,
      url: f.url,
      thumbnail: f.url,
      width: f.width ?? null,
      height: f.height ?? null,
      ext: f.ext || 'jpg',
      variants: [],
      source: 'yt-dlp',
    });
  }

  return items;
}

/**
 * Probe a URL and return everything available.
 * Tries yt-dlp first, then gallery-dl, then merges both.
 */
export async function probe(rawUrl) {
  const platform = detectPlatform(rawUrl);
  if (platform === 'file' && isDirectFile(rawUrl)) {
    return probeDirectFile(rawUrl);
  }

  // Telegram has no yt-dlp/gallery-dl support at all — handled separately.
  if (platform === 'telegram') {
    const { isTelegramSupported, probeTelegram } = await import('./telegram.js');
    if (isTelegramSupported(rawUrl)) {
      try {
        return await probeTelegram(rawUrl);
      } catch (err) {
        const e = new Error(err?.userFacing || err?.message || 'Telegram read failed.');
        e.userFacing = err?.userFacing || err?.message || 'Telegram read failed.';
        throw e;
      }
    }
  }

  // Pinterest's anonymous API is reached more reliably with a browser TLS
  // fingerprint than through yt-dlp's HTTP stack, so it gets its own path.
  if (platform === 'pinterest') {
    const { pinterestKind, probePinterest } = await import('./pinterest.js');
    if (pinterestKind(rawUrl)) {
      try {
        return await probePinterest(rawUrl);
      } catch (err) {
        const e = new Error(err?.userFacing || err?.message || 'Pinterest read failed.');
        e.userFacing = err?.userFacing || err?.message || 'Pinterest read failed.';
        throw e;
      }
    }
  }

  const py = pythonBin();
  const env = pathEnv();
  const warnings = [];
  let info = null;
  let galleryObjs = [];

  const y = await run(py, [...ytdlpBaseArgs(platform), '--dump-single-json', rawUrl], {
    timeout: 90000,
    env,
  });
  if (y.code === 0 && y.stdout.trim()) {
    info = parseJsonLoose(y.stdout);
    if (info && info.entries && info.entries.length) {
      info.entries = info.entries.filter(Boolean);
    }
  } else {
    const err = (y.stderr || '').split('\n').filter(Boolean).slice(-2).join(' ');
    if (err) warnings.push(`yt-dlp: ${err.slice(0, 220)}`);
  }

  const g = await run(py, [...galleryArgs(platform), rawUrl], { timeout: 90000, env });
  if (g.code === 0 && g.stdout.trim()) {
    const parsed = parseJsonLoose(g.stdout);
    if (Array.isArray(parsed)) galleryObjs = parsed;
  }

  const items = info ? ytdlpItems(info) : [];
  const images = galleryImages(galleryObjs);

  // Prefer gallery-dl's real image URLs over yt-dlp's thumbnail proxies.
  const photoItems = items.filter((i) => i.type === 'photo');
  const used = new Set();
  for (const p of photoItems) {
    const exact = images.find((im) => !used.has(im.url) && im.url === p.url);
    const spare = images.find((im) => !used.has(im.url) && im.type === 'photo');
    const match = exact || spare;
    if (match) {
      used.add(match.url);
      p.url = match.url;
      p.thumbnail = match.url;
      if (match.ext) p.ext = match.ext;
      p.width = match.width ?? p.width;
      p.height = match.height ?? p.height;
    }
  }
  for (const im of images) {
    if (used.has(im.url)) continue;
    const isPhoto = im.type !== 'video';
    items.push({
      id: `g${items.length}`,
      type: isPhoto ? 'photo' : 'video',
      title: isPhoto ? `Photo ${items.length + 1}` : 'Video',
      url: im.url,
      thumbnail: isPhoto ? im.url : null,
      width: im.width,
      height: im.height,
      ext: im.ext,
      variants: [],
      source: 'gallery-dl',
    });
  }

  // De-duplicate photos by URL.
  const seenPhoto = new Set();
  const deduped = items.filter((it) => {
    if (it.type !== 'photo') return true;
    const key = it.url || it.id;
    if (!key || seenPhoto.has(key)) return false;
    seenPhoto.add(key);
    return true;
  });

  const counts = {
    video: deduped.filter((i) => i.type === 'video').length,
    audio: deduped.filter((i) => i.type === 'audio').length,
    photo: deduped.filter((i) => i.type === 'photo').length,
  };

  if (!info && !images.length && !deduped.length) {
    const detail = warnings.join(' | ') || 'No extractor could read this URL.';
    const e = new Error(detail);
    e.userFacing = detail;
    throw e;
  }

  return {
    platform,
    title: info?.title || info?.description?.slice(0, 80) || deduped[0]?.title || 'Untitled',
    description: info?.description || null,
    author: info?.uploader || info?.channel || null,
    thumbnail: bestThumbnail(info),
    duration: info?.duration ?? null,
    webpageUrl: info?.webpage_url || rawUrl,
    counts,
    items: deduped,
    warnings,
    hasCookies: cookiesExist(),
  };
}

/**
 * Download one media item to a file.
 * video/audio -> yt-dlp ; photo -> direct HTTP fetch with referer.
 *
 * `outPath` may contain a yt-dlp output template (%(ext)s). Returns the real
 * path of the produced file.
 */
export async function downloadItem(rawUrl, item, opts, outPath) {
  const env = pathEnv();
  // Cookie selection needs the platform; derive it from the URL being fetched.
  const platform = detectPlatform(rawUrl);

  // Direct file URLs are fetched straight over HTTP — no extractor involved.
  if (item.source === 'direct' && item.url) {
    const res = await fetch(item.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    return outPath;
  }

  // Pinterest items carry their own direct media URLs (original-quality
  // image, or a video rendition) and must be fetched directly.
  if (item.source === 'pinterest') {
    const { fetchPinterestMedia } = await import('./pinterest.js');
    await fetchPinterestMedia(item, outPath);
    return outPath;
  }

  // Telegram media URLs are signed and short-lived; fetch them directly.
  if (item.source === 'telegram' && item.url) {
    const res = await fetch(item.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Referer: 'https://t.me/',
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`Telegram returned HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    return outPath;
  }

  if (item.type === 'photo') {
    const { fetchImage } = await import('./net.js');
    await fetchImage(item.url, outPath, rawUrl);
    return outPath;
  }

  const py = pythonBin();
  const args = [...ytdlpBaseArgs(platform), '-o', outPath, '--no-progress', '--no-playlist', '--no-part'];

  if (item.type === 'audio') {
    args.push('-x', '--audio-format', opts.audioFormat || 'mp3');
    args.push('-f', 'ba/b');
  } else {
    // A specific rendition may have been picked in the UI.
    const fid = item.variant?.format_id;
    if (fid) {
      args.push('-f', `${fid}+ba/${fid}/b`);
    } else {
      const quality = opts.quality || 'best';
      if (quality === 'best') args.push('-f', 'bv*+ba/b');
      else if (quality === 'hd') args.push('-f', 'bv*[height<=1080]+ba/b[height<=1080]/b');
      else if (quality === 'sd') args.push('-f', 'bv*[height<=480]+ba/b[height<=480]/b');
      else args.push('-f', 'bv*+ba/b');
    }
    if (opts.videoFormat && opts.videoFormat !== 'mp4') {
      args.push('--merge-output-format', opts.videoFormat);
    }
  }
  args.push(rawUrl);

  const r = await run(py, args, { timeout: 300000, env });
  if (r.code !== 0) {
    throw new Error(
      `yt-dlp failed: ${(r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || `exit ${r.code}`}`
    );
  }

  // Resolve %(ext)s to the actual file that was written.
  if (!outPath.includes('%(ext)s')) return outPath;
  const dir = path.dirname(outPath);
  const stem = path.basename(outPath).split('.%(ext)s')[0];
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.startsWith(stem) && !f.endsWith('.part'));
  } catch {
    /* directory may not exist */
  }
  if (!entries.length) return outPath;
  // Prefer the largest produced file (thumbnails can also match the stem).
  entries.sort((a, b) => {
    const sa = fs.statSync(path.join(dir, a)).size;
    const sb = fs.statSync(path.join(dir, b)).size;
    return sb - sa;
  });
  return path.join(dir, entries[0]);
}

export { ytdlpBaseArgs, galleryArgs, parseJsonLoose };
