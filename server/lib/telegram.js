/**
 * Telegram media extraction.
 *
 * Two shapes of link are supported, and they need different treatment:
 *
 *   1. A single public post   t.me/<channel>/<id>
 *      Telegram's per-post embed only serves media to a session that carries
 *      a `stel_tme_token`, so we do not use it. Instead we load the channel's
 *      /s/ preview page and pick the post out by its id.
 *
 *   2. A channel preview      t.me/s/<channel>
 *      Read directly, and every post on it is available.
 *
 * Both go through a headless browser because the markup is rendered by
 * JavaScript and the media URLs carry signed tokens that expire.
 */

import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const POST_RE = /^https?:\/\/(?:t\.me|telegram\.me)\/([A-Za-z0-9_]+)\/(\d+)(?:\?|$|\/)/;
const CHANNEL_RE = /^https?:\/\/(?:t\.me|telegram\.me)\/s\/([A-Za-z0-9_]+)(?:\?|$|\/)/;

export function telegramLinkInfo(rawUrl) {
  const post = rawUrl.match(POST_RE);
  if (post) return { kind: 'post', channel: post[1], id: post[2] };
  const channel = rawUrl.match(CHANNEL_RE);
  if (channel) return { kind: 'channel', channel: channel[1] };
  return null;
}

export function isTelegramSupported(rawUrl) {
  return !!telegramLinkInfo(rawUrl);
}

let browserPromise = null;

/** One shared browser instance — launching per request is far too slow. */
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
  }
  return browserPromise;
}

/** Read the rendered channel preview page and collect its posts. */
async function readChannel(channel, { limit = 60 } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });
  const page = await context.newPage();

  try {
    await page.goto(`https://t.me/s/${channel}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    // Let the widget render its media.
    await page.waitForTimeout(2500);
    try {
      await page.waitForSelector('.tgme_widget_message_wrap', { timeout: 15000 });
    } catch {
      /* channel may have no rendered posts */
    }

    return await page.evaluate((max) => {
      const posts = [];
      const wraps = document.querySelectorAll('.tgme_widget_message_wrap');
      for (const wrap of wraps) {
        if (posts.length >= max) break;

        const dateEl = wrap.querySelector('.tgme_widget_message_date');
        const link = dateEl?.getAttribute('href') || '';

        const imgs = [...wrap.querySelectorAll('.tgme_widget_message_photo_wrap')]
          .map((e) => {
            const style = e.getAttribute('style') || '';
            const m = style.match(/background-image:url\('([^']+)'\)/);
            return m ? m[1] : null;
          })
          .filter(Boolean);

        const vids = [...wrap.querySelectorAll('video')]
          .map((v) => v.getAttribute('src'))
          .filter(Boolean);

        const textEl = wrap.querySelector('.tgme_widget_message_text');
        const text = textEl ? textEl.textContent.trim().slice(0, 140) : '';

        if (!imgs.length && !vids.length) continue;

        posts.push({ link, imgs, vids, text });
      }
      const channelName =
        document.querySelector('.tgme_channel_info_header_title')?.textContent?.trim() ||
        document.title ||
        channel;
      return { channelName, posts };
    }, limit);
  } finally {
    await context.close();
  }
}

/** Split a t.me post link into channel + id. */
function postKey(link) {
  const m = String(link || '').match(POST_RE);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Probe a Telegram link. Returns every media item found.
 */
export async function probeTelegram(rawUrl) {
  const info = telegramLinkInfo(rawUrl);
  if (!info) {
    const e = new Error('Not a supported Telegram link.');
    e.userFacing = 'Use a public Telegram post link (t.me/channel/123) or a channel (t.me/s/channel).';
    throw e;
  }

  let posts;
  let title;
  let author;

  if (info.kind === 'channel') {
    const data = await readChannel(info.channel);
    posts = data.posts;
    title = data.channelName || info.channel;
    author = info.channel;
  } else {
    // A single post: read the channel and find that post by id.
    const data = await readChannel(info.channel);
    const key = `${info.channel}/${info.id}`;
    const found = data.posts.find((p) => postKey(p.link) === key);
    if (!found) {
      const e = new Error(
        `Post ${key} was not found in the channel preview. It may be private, deleted, or too old to still be listed.`
      );
      e.userFacing =
        'That Telegram post could not be found in its channel preview. It may be private or deleted.';
      throw e;
    }
    posts = [found];
    title = found.text || `Post ${info.id}`;
    author = info.channel;
  }

  const items = [];
  for (const p of posts) {
    for (const url of p.imgs) {
      items.push({
        id: `t${items.length}`,
        type: 'photo',
        title: `Photo ${items.length + 1}`,
        url,
        thumbnail: url,
        ext: 'jpg',
        variants: [],
        source: 'telegram',
      });
    }
    for (const url of p.vids) {
      items.push({
        id: `t${items.length}`,
        type: 'video',
        title: 'Video',
        url,
        thumbnail: null,
        ext: 'mp4',
        variants: [],
        source: 'telegram',
      });
    }
  }

  const counts = {
    video: items.filter((i) => i.type === 'video').length,
    audio: 0,
    photo: items.filter((i) => i.type === 'photo').length,
  };

  if (!items.length) {
    const e = new Error('No media found in that Telegram link.');
    e.userFacing = 'No photos or videos were found in that Telegram link.';
    throw e;
  }

  return {
    platform: 'telegram',
    platformName: 'Telegram',
    platformColor: '#2aabee',
    title: title || 'Telegram',
    description: posts[0]?.text || null,
    author,
    thumbnail: items.find((i) => i.type === 'photo')?.url || null,
    duration: null,
    webpageUrl: rawUrl,
    counts,
    items,
    warnings: [],
    hasCookies: false,
    cookieHint: null,
  };
}

/** Shut the shared browser down (used by tests and graceful shutdown). */
export async function closeTelegram() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      await b.close();
    } catch {
      /* already closed */
    }
    browserPromise = null;
  }
}
